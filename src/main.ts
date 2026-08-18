#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env

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
import { WorkItemReleaseManager } from "./release-manager.ts";
import { SignalJsonRpc } from "./signal-json-rpc.ts";
import { WorkItemStore } from "./store.ts";
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
  config: IntakeConfig,
  message: IncomingSignalMessage,
  project: string,
  instruction: string,
  mode: "task" | "question",
): WorkItem {
  const id = randomUUID().replaceAll("-", "").slice(0, 10);
  const projectConfig = config.projects[project];
  if (!projectConfig) throw new Error(`Unknown project: ${project}`);
  const stamp = new Date(message.timestamp).toISOString().replaceAll(/[-:]/gu, "").slice(0, 13);
  const branch = mode === "task" && projectConfig.allowWrite && projectConfig.isolatedWorktree
    ? `codex/signal-${stamp}-${id}`
    : undefined;
  return {
    id,
    mode,
    project,
    instruction,
    ...(branch ? { branch } : {}),
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
    `project: ${record.item.project}`,
  ];
  if (record.item.branch) lines.push(`branch: ${record.item.branch}`);
  if (record.result?.commit) lines.push(`commit: ${record.result.commit}`);
  if (record.publication) {
    lines.push(
      `published: ${record.publication.remote}/${record.publication.branch} @ ${
        record.publication.commit.slice(0, 12)
      }`,
    );
  }
  if (record.deployment) {
    lines.push(
      `deployed: ${record.deployment.commit.slice(0, 12)} @ ${record.deployment.deployedAt}`,
    );
  }
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
    `project: ${item.project}`,
  ];
  if (item.branch) lines.push(`branch: ${item.branch}`);
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
  for (const [key, project] of Object.entries(config.projects)) {
    try {
      await execFileAsync("git", ["-C", project.path, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        timeout: 10_000,
      });
    } catch (error) {
      throw new Error(`Project ${key} is not an accessible git checkout at ${project.path}`, {
        cause: error,
      });
    }
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
              `project: ${active.project}`,
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
        const project = config.projects[active.project];
        if (!project) {
          await signal.sendGroupMessage(
            `✗ capture project is no longer configured: ${active.project}`,
          );
          return;
        }
        try {
          const completed = await captures.complete(message.sender, message.groupId, project.path);
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

      const configuredProjects = Object.keys(config.projects);
      const projectKey = command.project ??
        (configuredProjects.length === 1 ? configuredProjects[0] : undefined);
      if (!projectKey) {
        await signal.sendGroupMessage(
          "✗ specify a project when more than one project is configured.",
        );
        return;
      }
      if (!config.projects[projectKey]) {
        await signal.sendGroupMessage(`✗ unknown project: ${projectKey}`);
        return;
      }
      try {
        const started = await captures.start(
          message.sender,
          message.groupId,
          projectKey,
          command.title,
        );
        await eventLog.record("context.capture.started", {
          captureId: started.id,
          project: started.project,
          sender: started.sender,
          conversation: started.conversation,
        });
        await signal.sendGroupMessage([
          `🎙️ Capturing context for ${projectKey}`,
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
      if (command.project) {
        const project = config.projects[command.project];
        await signal.sendGroupMessage(
          project
            ? [
              `project: ${command.project}`,
              `write: ${project.allowWrite ? "allowed" : "read-only"}`,
              `workspace: ${
                project.isolatedWorktree ? "isolated git worktree" : "registered checkout"
              }`,
              `base: ${project.baseRef}`,
            ].join("\n")
            : `✗ unknown project: ${command.project}`,
        );
      } else {
        await signal.sendGroupMessage(
          `projects: ${Object.keys(config.projects).sort().join(", ")}`,
        );
      }
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
    if (command.kind === "publish" || command.kind === "deploy") {
      const record = store.get(command.id);
      if (!record || record.item.source.sender !== message.sender) {
        await signal.sendGroupMessage("No matching work item.");
        return;
      }
      if (
        command.kind === "deploy" && record.deployment &&
        record.deployment.commit === record.publication?.commit
      ) {
        await signal.sendGroupMessage(
          `Already deployed: ${record.item.id} @ ${record.deployment.commit.slice(0, 12)}`,
        );
        return;
      }
      try {
        await signal.sendGroupMessage(
          `${
            command.kind === "publish" ? "Publishing" : "Deploying to production"
          }…\nid: ${record.item.id}`,
        );
        if (command.kind === "publish") {
          const publication = await releases.publish(record);
          await store.update(record.item.id, { publication });
          await signal.sendGroupMessage([
            "✓ published",
            `id: ${record.item.id}`,
            `remote: ${publication.remote}`,
            `branch: ${publication.branch}`,
            `commit: ${publication.commit.slice(0, 12)}`,
          ].join("\n"));
        } else {
          const { deployment, output } = await releases.deploy(record);
          await store.update(record.item.id, { deployment });
          const outputTail = output.length > 1200 ? `…${output.slice(-1199)}` : output;
          await signal.sendGroupMessage([
            "✓ deployed to production",
            `id: ${record.item.id}`,
            `commit: ${deployment.commit.slice(0, 12)}`,
            ...(outputTail ? ["", "Output:", outputTail] : []),
          ].join("\n"));
        }
      } catch (error) {
        await signal.sendGroupMessage(
          `✗ ${command.kind} failed\nid: ${record.item.id}\n${(error as Error).message}`,
        );
      }
      return;
    }
    if (command.kind === "feature") {
      const configuredProjects = Object.keys(config.projects);
      const projectKey = configuredProjects.length === 1 ? configuredProjects[0] : undefined;
      const project = projectKey ? config.projects[projectKey] : undefined;
      if (!project) {
        await signal.sendGroupMessage("✗ /feature requires exactly one configured project.");
        return;
      }
      try {
        const recorded = await recordFeatureRequest(project.path, message, command.request);
        await signal.sendGroupMessage(
          recorded.created
            ? `✓ feature recorded\npath: ${recorded.relativePath}`
            : `Already recorded\npath: ${recorded.relativePath}`,
        );
      } catch (error) {
        await signal.sendGroupMessage(`✗ feature request failed\n${(error as Error).message}`);
      }
      return;
    }
    if (command.kind === "dispatch") {
      const configuredProjects = Object.keys(config.projects);
      const projectKey = configuredProjects.length === 1 ? configuredProjects[0] : undefined;
      const project = projectKey ? config.projects[projectKey] : undefined;
      if (!project) {
        await signal.sendGroupMessage("✗ /dispatch requires exactly one configured project.");
        return;
      }
      try {
        await signal.sendGroupMessage("Generating Entire dispatch…");
        const result = await generateEntireDispatch(
          config.entire.executable,
          project.path,
          command.args,
        );
        await eventLog.record("entire.dispatch.completed", {
          executable: config.entire.executable,
          cwd: project.path,
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
          cwd: project.path,
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

    const configuredProjects = Object.keys(config.projects);
    const project = command.project ??
      (configuredProjects.length === 1 ? configuredProjects[0] : undefined);
    if (!project) {
      await signal.sendGroupMessage(
        "✗ specify a project when more than one project is configured.",
      );
      return;
    }
    if (!config.projects[project]) {
      await signal.sendGroupMessage(`✗ unknown project: ${project}`);
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
    const item = newWorkItem(config, message, project, instruction, mode);
    await store.put({ item, status: "queued", updatedAt: new Date().toISOString() });
    await signal.sendGroupMessage([
      "✓ task accepted",
      `id: ${item.id}`,
      `project: ${item.project}`,
      `mode: ${item.mode === "question" ? "read-only question" : "work task"}`,
      ...(item.branch ? [`branch: ${item.branch}`] : []),
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
          const project = config.projects[item.project];
          if (!project) throw new Error(`Project ${item.project} is no longer configured.`);
          const workspace = project.isolatedWorktree && item.branch
            ? join(config.stateDirectory, "worktrees", item.id)
            : project.path;
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
      if (item.mode !== "question" && config.projects[item.project]?.release) {
        try {
          await signal.sendGroupMessage(`Validating and publishing…\nid: ${item.id}`);
          const record = store.get(item.id);
          if (!record) throw new Error(`Work item ${item.id} disappeared from the store.`);
          const publication = await releases.publish(record);
          const published = await store.update(item.id, { publication });
          await signal.sendGroupMessage([
            "✓ validated and published",
            `id: ${item.id}`,
            `branch: ${publication.remote}/${publication.branch}`,
            `commit: ${publication.commit.slice(0, 12)}`,
          ].join("\n"));

          if (config.projects[item.project]?.release?.deployCommand) {
            await signal.sendGroupMessage(`Deploying to production…\nid: ${item.id}`);
            const deployed = await releases.deploy(published);
            await store.update(item.id, { deployment: deployed.deployment });
            await signal.sendGroupMessage([
              "✓ deployed to production",
              `id: ${item.id}`,
              `commit: ${deployed.deployment.commit.slice(0, 12)}`,
              ...(deployed.output ? [deployed.output.slice(0, 1200)] : []),
            ].join("\n"));
          }
        } catch (error) {
          await signal.sendGroupMessage([
            "✗ automatic release stopped",
            `id: ${item.id}`,
            (error as Error).message.slice(0, 1500),
            "The completed work is retained; use /publish or /deploy to retry.",
          ].join("\n"));
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
      `Signal Control Tower configuration is valid for ${config.signal.groupName}; projects: ${
        Object.keys(config.projects).join(", ")
      }\n`,
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

  process.stdout.write(`Listening to Signal group ${config.signal.groupName}\n`);
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
