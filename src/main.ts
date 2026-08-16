#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { activityMessageBlocks, generateActivityDispatch } from "./activity.ts";
import { validateArtifactPaths } from "./artifacts.ts";
import { CodexWorkQueue } from "./codex-runner.ts";
import { loadConfig } from "./config.ts";
import { recordFeatureRequest } from "./feature-request.ts";
import { SignalOutbox } from "./outbox.ts";
import { parseIntakeCommand, signalNotificationToMessage } from "./protocol.ts";
import { WorkItemReleaseManager } from "./release-manager.ts";
import { SignalJsonRpc } from "./signal-json-rpc.ts";
import { WorkItemStore } from "./store.ts";
import type {
  IncomingSignalMessage,
  IntakeConfig,
  WorkItem,
  WorkItemRecord,
  WorkItemResult,
} from "./types.ts";

const HELP = [
  "🗼 Signal Control Tower",
  "",
  "🤖 /codex <task> — build or fix",
  "🔎 /ask <question> — inspect code",
  "💡 /feature <idea> — save a request",
  "📡 /activity [flags] — recent agent work",
  "📍 /status [id] — check progress",
  "🛑 /cancel [id] — stop work",
  "🚀 /publish <id> — test · commit · push",
  "🌎 /deploy <id> — ship production",
  "🧭 /context [project] — show setup",
  "✨ /help — show this card",
].join("\n");

const execFileAsync = promisify(execFile);

function cliOptions(args: string[]): { configPath: string; doctor: boolean } {
  let configPath = "signal-control-tower.json";
  let doctor = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--doctor") doctor = true;
    else if (arg === "--config") {
      const value = args[index + 1];
      if (!value) throw new Error("--config requires a path");
      configPath = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: deno task start -- [--config PATH] [--doctor]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  return { configPath, doctor };
}

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
  await execFileAsync(config.activity.executable, ["--version"], {
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
  const options = cliOptions(process.argv.slice(2));
  const config = await loadConfig(options.configPath);
  const store = new WorkItemStore(config.stateDirectory);
  await store.load();
  await verifyLocalExecution(config);
  const releases = new WorkItemReleaseManager(config);

  let queue: CodexWorkQueue;
  const signal = new SignalJsonRpc(config.signal, async (notification) => {
    const message = signalNotificationToMessage(notification);
    if (!message || message.groupId !== config.signal.groupId) return;
    if (!config.signal.allowedSenders.includes(message.sender)) {
      process.stderr.write(`[signal-control-tower] rejected sender ${message.sender}\n`);
      return;
    }

    const command = parseIntakeCommand(message.message);
    if (command.kind === "ignore") return;
    if (command.kind === "invalid") {
      await signal.sendGroupMessage(`✗ ${command.reason}`);
      return;
    }
    if (command.kind === "help") {
      await signal.sendGroupMessage(HELP);
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
    if (command.kind === "activity") {
      const configuredProjects = Object.keys(config.projects);
      const projectKey = configuredProjects.length === 1 ? configuredProjects[0] : undefined;
      const project = projectKey ? config.projects[projectKey] : undefined;
      if (!project) {
        await signal.sendGroupMessage("✗ /activity requires exactly one configured project.");
        return;
      }
      try {
        await signal.sendGroupMessage("Generating activity dispatch…");
        const dispatch = await generateActivityDispatch(
          config.activity.executable,
          project.path,
          command.args,
        );
        const blocks = activityMessageBlocks(dispatch);
        for (const [index, block] of blocks.entries()) {
          const heading = blocks.length === 1
            ? "Activity dispatch"
            : `Activity dispatch ${index + 1}/${blocks.length}`;
          await signal.sendGroupMessage(`${heading}\n\n${block}`);
        }
      } catch (error) {
        await signal.sendGroupMessage(
          `✗ activity dispatch failed\n${(error as Error).message.slice(0, 1500)}`,
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
  });

  queue = new CodexWorkQueue(config, store, async (item, event) => {
    if (event.kind === "started") {
      await signal.sendGroupMessage(
        `${
          item.mode === "question" ? "Codex is researching" : "Codex is working"
        }…\nid: ${item.id}`,
      );
    } else if (event.kind === "completed") {
      for (const block of activityMessageBlocks(completion(item, event.result))) {
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

  const outbox = new SignalOutbox(join(config.stateDirectory, "outbox"), async (message) => {
    for (const block of activityMessageBlocks(message)) await signal.sendGroupMessage(block);
  });
  await outbox.start();

  for (const record of store.all().reverse()) {
    if (record.status === "running") {
      await store.update(record.item.id, {
        status: "interrupted",
        error:
          "The intake daemon stopped while this item was running; it was not resumed automatically.",
      });
    } else if (record.status === "queued") {
      queue.enqueue(record.item);
    }
  }

  process.stdout.write(`Listening to Signal group ${config.signal.groupName}\n`);
  const stop = (): void => {
    outbox.stop();
    signal.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

run().catch((error: unknown) => {
  process.stderr.write(`[signal-control-tower] fatal: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
