#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net=127.0.0.1:8765

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { generateEntireDispatch, signalMessageBlocks } from "./entire.ts";
import { validateArtifactPaths } from "./artifacts.ts";
import { CodexWorkQueue } from "./codex-runner.ts";
import { loadConfig } from "./config.ts";
import { ContextCaptureStore } from "./context-capture.ts";
import { recordFeatureRequest } from "./feature-request.ts";
import { EventLog } from "./event-log.ts";
import { SignalOutbox } from "./outbox.ts";
import { parseIntakeCommand, signalNotificationToMessage } from "./protocol.ts";
import { cleanCommandOutput, WorkItemReleaseManager } from "./release-manager.ts";
import { SignalJsonRpc } from "./signal-json-rpc.ts";
import { WorkItemStore } from "./store.ts";
import { startMcpServer } from "./mcp-server.ts";
import {
  commandEnabled,
  helpMessage,
  parseStartupOptions,
  shutdownAnnouncement,
  startupAnnouncement,
} from "./startup.ts";
import type {
  IncomingSignalMessage,
  IntakeConfig,
  WorkItem,
  WorkItemRecord,
  WorkItemResult,
} from "./types.ts";

const execFileAsync = promisify(execFile);

function group(value: unknown, groupId: string): Record<string, unknown> | undefined {
  return Array.isArray(value)
    ? value.find((entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null &&
      (entry as Record<string, unknown>).id === groupId
    )
    : undefined;
}

function newWorkItem(
  message: IncomingSignalMessage,
  instruction: string,
  mode: "task" | "question",
): WorkItem {
  const id = randomUUID().replaceAll("-", "").slice(0, 10);
  return {
    id,
    mode,
    instruction,
    attachments: message.attachments,
    source: {
      transport: "signal",
      sender: message.sender,
      conversation: message.groupId,
      messageId: `${message.groupId}:${message.sender}:${message.timestamp}`,
      timestamp: message.timestamp,
    },
    createdAt: new Date().toISOString(),
  };
}

function formatRecord(record: WorkItemRecord): string {
  const lines = [
    `${record.item.id}: ${record.status}`,
  ];
  if (record.result?.commit) lines.push(`commit: ${record.result.commit}`);
  if (record.result?.filesChanged !== undefined) {
    lines.push(`files changed: ${record.result.filesChanged}`);
  }
  if (record.error) lines.push(`error: ${record.error}`);
  return lines.join("\n");
}

function completion(item: WorkItem, result: WorkItemResult): string {
  const lines = [
    item.mode === "question" ? "✓ answered" : "✓ completed",
    `id: ${item.id}`,
  ];
  lines.push(`files changed: ${String(result.filesChanged ?? 0)}`);
  if (result.commit) lines.push(`commit: ${result.commit}`);
  lines.push("", "Summary:", result.summary);
  return lines.join("\n");
}

async function verifyLocalExecution(config: IntakeConfig): Promise<void> {
  await execFileAsync(config.codex.executable, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  await execFileAsync(config.entire.executable, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  try {
    await execFileAsync("git", ["-C", config.workspace.path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch (error) {
    throw new Error(`Workspace is not an accessible git checkout at ${config.workspace.path}`, {
      cause: error,
    });
  }
}

async function run(): Promise<void> {
  let options;
  try {
    options = parseStartupOptions(process.argv.slice(2));
  } catch (error) {
    if ((error as Error).message !== "help") throw error;
    process.stdout.write(
      "Usage: deno task start -- [--config PATH] [--doctor] [--mode ask,feature,dispatch]\n",
    );
    return;
  }
  const config = await loadConfig(options.configPath);
  const store = new WorkItemStore(config.stateDirectory);
  const eventLog = new EventLog(config.stateDirectory);
  const captures = new ContextCaptureStore(config.stateDirectory);
  await store.load();
  await captures.load();
  await verifyLocalExecution(config);
  const releases = new WorkItemReleaseManager(config);

  let queue: CodexWorkQueue;
  const signal = new SignalJsonRpc(config.signal, async (notification) => {
    const message = signalNotificationToMessage(notification);
    if (!message || message.groupId !== config.signal.groupId) return;
    if (!config.signal.allowedSenders.includes(message.sender)) {
      await eventLog.record("signal.inbound.rejected", {
        sender: message.sender,
        groupId: message.groupId,
        timestamp: message.timestamp,
      });
      process.stderr.write(`[signal-control-tower] rejected sender ${message.sender}\n`);
      return;
    }

    await eventLog.record(
      "signal.inbound.accepted",
      { message, notification },
      message.attachments.flatMap((attachment) => attachment.path ? [attachment.path] : []),
    );

    const command = parseIntakeCommand(message.message);
    await eventLog.record("intake.parsed", {
      messageId: `${message.groupId}:${message.sender}:${message.timestamp}`,
      command,
    });
    if (command.kind === "ignore") {
      const capture = await captures.append(message);
      if (capture) {
        await eventLog.record("context.capture.message", {
          captureId: capture.id,
          messageId: `${message.groupId}:${message.sender}:${message.timestamp}`,
          messageCount: capture.messages.length,
        });
      }
      return;
    }
    if (command.kind === "invalid") {
      await signal.sendGroupMessage(`✗ ${command.reason}`);
      return;
    }
    const activeCapture = captures.activeFor(message.sender, message.groupId);
    if (activeCapture && command.kind !== "capture") {
      await signal.sendGroupMessage(
        `✗ capture ${activeCapture.id} is active; only /capture status, /capture done, or /capture cancel are allowed.`,
      );
      return;
    }
    if (!commandEnabled(command, options)) {
      await signal.sendGroupMessage(
        `✗ /${command.kind} is disabled in this startup mode. Enabled: ${
          options.modes.join(", ")
        }.`,
      );
      return;
    }
    if (command.kind === "help") {
      await signal.sendGroupMessage(helpMessage(options));
      return;
    }
    if (command.kind === "capture") {
      const active = captures.activeFor(message.sender, message.groupId);
      if (command.action === "status") {
        await signal.sendGroupMessage(
          active
            ? [
              `🎙️ capture active`,
              `session: ${active.id}`,
              `workspace: ${active.workspace}`,
              `messages: ${active.messages.length}`,
              `started: ${active.startedAt}`,
            ].join("\n")
            : "No active context capture.",
        );
        return;
      }
      if (command.action === "cancel") {
        const cancelled = await captures.cancel(message.sender, message.groupId);
        await signal.sendGroupMessage(
          cancelled
            ? `Context capture cancelled: ${cancelled.id} (${cancelled.messages.length} messages retained in the audit log)`
            : "No active context capture.",
        );
        return;
      }
      if (command.action === "done") {
        if (!active) {
          await signal.sendGroupMessage("No active context capture.");
          return;
        }
        try {
          const completed = await captures.complete(
            message.sender,
            message.groupId,
            config.workspace.path,
          );
          if (!completed) throw new Error("The capture is no longer active.");
          await eventLog.record("context.capture.completed", { ...completed });
          await signal.sendGroupMessage([
            "✓ context captured",
            `session: ${completed.id}`,
            `messages: ${completed.messageCount}`,
            `attachments: ${completed.attachmentCount}`,
            `path: ${completed.relativePath}`,
          ].join("\n"));
        } catch (error) {
          await signal.sendGroupMessage(`✗ context capture failed\n${(error as Error).message}`);
        }
        return;
      }

      try {
        const started = await captures.start(
          message.sender,
          message.groupId,
          "workspace",
          command.title,
        );
        await eventLog.record("context.capture.started", {
          captureId: started.id,
          workspace: started.workspace,
          sender: started.sender,
          conversation: started.conversation,
        });
        await signal.sendGroupMessage([
          "🎙️ Capturing context for the workspace",
          `session: ${started.id}`,
          "Send messages and attachments normally.",
          "Use /capture done when finished.",
        ].join("\n"));
      } catch (error) {
        await signal.sendGroupMessage(`✗ ${(error as Error).message}`);
      }
      return;
    }
    if (command.kind === "context") {
      await signal.sendGroupMessage([
        `workspace: ${config.workspace.path}`,
        `write: ${config.workspace.allowWrite ? "allowed" : "read-only"}`,
        `validation: ${config.workspace.validateCommand.join(" ")}`,
      ].join("\n"));
      return;
    }
    if (command.kind === "status") {
      const record = command.id ? store.get(command.id) : store.latestForSender(message.sender);
      await signal.sendGroupMessage(
        !record || record.item.source.sender !== message.sender
          ? "No matching work item."
          : formatRecord(record),
      );
      return;
    }
    if (command.kind === "cancel") {
      const record = command.id ? store.get(command.id) : store.latestForSender(message.sender);
      if (!record || record.item.source.sender !== message.sender) {
        await signal.sendGroupMessage("No matching work item.");
        return;
      }
      const outcome = await queue.cancel(record.item.id);
      await signal.sendGroupMessage(
        outcome === "cancelled"
          ? `Cancellation requested: ${record.item.id}`
          : `${record.item.id} is not running or queued.`,
      );
      return;
    }
    if (command.kind === "ship") {
      try {
        await signal.sendGroupMessage("Shipping workspace…");
        const result = await releases.ship((progress) => signal.sendGroupMessage(progress));
        const diagnosticLines = result.output.split("\n").filter((line) => line.trim()).length;
        await signal.sendGroupMessage([
          "🚀 SHIP COMPLETE",
          "",
          `Commit: ${result.commit.slice(0, 12)}`,
          `Local changes: ${result.stash ? `preserved in ${result.stash}` : "none detected"}`,
          "",
          "Steps",
          ...result.steps.map((step) => `✅ ${step}`),
          ...(diagnosticLines > 0
            ? ["", "Diagnostics", `⚠️ ${diagnosticLines} output lines emitted`]
            : []),
        ].join("\n"));
      } catch (error) {
        await signal.sendGroupMessage(
          `✗ ship failed\n${cleanCommandOutput((error as Error).message)}`,
        );
      }
      return;
    }
    if (command.kind === "feature") {
      try {
        const recorded = await recordFeatureRequest(
          config.workspace.path,
          message,
          command.request,
        );
        await signal.sendGroupMessage([
          recorded.created ? "✓ feature recorded" : "Already recorded",
          `path: ${recorded.relativePath}`,
          ...(recorded.issueUrl ? [`github issue: ${recorded.issueUrl}`] : []),
          ...(recorded.issueError ? [`github issue unavailable: ${recorded.issueError}`] : []),
        ].join("\n"));
      } catch (error) {
        await signal.sendGroupMessage(`✗ feature request failed\n${(error as Error).message}`);
      }
      return;
    }
    if (command.kind === "dispatch") {
      try {
        await signal.sendGroupMessage("Generating Entire dispatch…");
        const result = await generateEntireDispatch(
          config.entire.executable,
          config.workspace.path,
          command.args,
        );
        await eventLog.record("entire.dispatch.completed", {
          executable: config.entire.executable,
          cwd: config.workspace.path,
          args: ["dispatch", ...command.args],
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
        });
        const blocks = signalMessageBlocks(result.output);
        for (const [index, block] of blocks.entries()) {
          const heading = blocks.length === 1
            ? "Entire dispatch"
            : `Entire dispatch ${index + 1}/${blocks.length}`;
          await signal.sendGroupMessage(`${heading}\n\n${block}`);
        }
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string };
        await eventLog.record("entire.dispatch.failed", {
          executable: config.entire.executable,
          cwd: config.workspace.path,
          args: ["dispatch", ...command.args],
          error: failure.message,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
        });
        await signal.sendGroupMessage(
          `✗ Entire dispatch failed\n${(error as Error).message.slice(0, 1500)}`,
        );
      }
      return;
    }

    const messageId = `${message.groupId}:${message.sender}:${message.timestamp}`;
    const duplicate = store.findByMessageId(messageId);
    if (duplicate) {
      await signal.sendGroupMessage(`Already accepted: ${duplicate.item.id}`);
      return;
    }
    const mode = command.kind === "ask" ? "question" : "task";
    const instruction = command.kind === "ask" ? command.question : command.instruction;
    const item = newWorkItem(message, instruction, mode);
    await store.put({ item, status: "queued", updatedAt: new Date().toISOString() });
    await signal.sendGroupMessage([
      "✓ task accepted",
      `id: ${item.id}`,
      `mode: ${item.mode === "question" ? "read-only question" : "work task"}`,
      `attachments: ${item.attachments.length} metadata-only`,
    ].join("\n"));
    queue.enqueue(item);
  }, (kind, data, attachments) => eventLog.record(kind, data, attachments));

  queue = new CodexWorkQueue(config, store, async (item, event) => {
    await eventLog.record(`work.${event.kind}`, { item, event });
    if (event.kind === "started") {
      await signal.sendGroupMessage(
        `${
          item.mode === "question" ? "Codex is researching" : "Codex is working"
        }…\nid: ${item.id}`,
      );
    } else if (event.kind === "completed") {
      for (const block of signalMessageBlocks(completion(item, event.result))) {
        await signal.sendGroupMessage(block);
      }
      if (event.result.artifactPaths?.length) {
        try {
          const workspace = config.workspace.path;
          const attachments = await validateArtifactPaths(workspace, event.result.artifactPaths);
          await signal.sendGroupAttachments(`Artifacts from ${item.id}`, attachments);
        } catch (error) {
          await signal.sendGroupMessage(
            `✗ could not send attachments\nid: ${item.id}\n${
              (error as Error).message.slice(0, 1500)
            }`,
          );
        }
      }
    } else if (event.kind === "cancelled") {
      await signal.sendGroupMessage(`Cancelled: ${item.id}`);
    } else {
      await signal.sendGroupMessage(`✗ failed\nid: ${item.id}\n${event.error}`);
    }
  });

  await signal.start();
  const groups = await signal.listGroups();
  const configuredGroup = group(groups, config.signal.groupId);
  if (!configuredGroup) {
    throw new Error(`Configured Signal group ID was not found: ${config.signal.groupId}`);
  }
  if (configuredGroup.name !== config.signal.groupName) {
    throw new Error(
      `Signal group name mismatch: expected ${config.signal.groupName}, got ${
        String(configuredGroup.name)
      }`,
    );
  }

  if (options.doctor) {
    process.stdout.write(
      `Signal Control Tower configuration is valid for ${config.signal.groupName}; workspace: ${config.workspace.path}\n`,
    );
    signal.stop();
    return;
  }

  await store.interruptActiveQueue();
  await signal.sendGroupMessage(startupAnnouncement(options));

  const outbox = new SignalOutbox(join(config.stateDirectory, "outbox"), async (delivery) => {
    if (delivery.attachments.length) {
      await signal.sendGroupAttachments(delivery.message, delivery.attachments);
      return;
    }
    for (const block of signalMessageBlocks(delivery.message)) {
      await signal.sendGroupMessage(block);
    }
  });
  await outbox.start();
  const mcpServer = await startMcpServer({
    host: config.mcp.host,
    port: config.mcp.port,
    stateDirectory: config.stateDirectory,
    workspace: config.workspace.path,
  });

  process.stdout.write(`Listening to Signal group ${config.signal.groupName}\n`);
  process.stdout.write(`MCP listening at http://${config.mcp.host}:${config.mcp.port}/mcp\n`);
  let stopping = false;
  const stop = async (shutdownSignal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`Shutting down after ${shutdownSignal}\n`);
    try {
      await eventLog.record("shutdown.requested", { signal: shutdownSignal });
      try {
        await signal.sendGroupMessage(shutdownAnnouncement(shutdownSignal));
        await eventLog.record("shutdown.broadcast", { signal: shutdownSignal, delivered: true });
      } catch (error) {
        await eventLog.record("shutdown.broadcast", {
          signal: shutdownSignal,
          delivered: false,
          error: (error as Error).message,
        });
        process.stderr.write(
          `[signal-control-tower] shutdown broadcast failed: ${(error as Error).message}\n`,
        );
      }
      await eventLog.record("shutdown.completed", { signal: shutdownSignal });
    } catch (error) {
      process.stderr.write(
        `[signal-control-tower] shutdown logging failed: ${(error as Error).message}\n`,
      );
    } finally {
      outbox.stop();
      await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
      signal.stop();
      process.exitCode = 0;
    }
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

run().catch((error: unknown) => {
  process.stderr.write(`[signal-control-tower] fatal: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
