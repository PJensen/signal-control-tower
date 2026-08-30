import { type ChildProcess, execFile, spawn } from "node:child_process";
import { setTimeout } from "node:timers";
import { promisify } from "node:util";

import { buildCodexArguments } from "./codex-arguments.ts";
import { extractArtifactDeclarations } from "./artifacts.ts";
import { WorkItemStore } from "./store.ts";
import type { IntakeConfig, WorkItem, WorkItemResult, WorkspaceConfig } from "./types.ts";

const execFileAsync = promisify(execFile);

type QueueEvent =
  | { kind: "started"; workspace: string }
  | { kind: "completed"; result: WorkItemResult }
  | { kind: "failed"; error: string }
  | { kind: "cancelled" };

type QueueNotifier = (item: WorkItem, event: QueueEvent) => void | Promise<void>;

interface ActiveRun {
  item: WorkItem;
  child: ChildProcess | undefined;
  cancelling: boolean;
}

function taskPrompt(item: WorkItem, workspaceConfig: WorkspaceConfig): string {
  const attachmentNote = item.attachments.length === 0
    ? "No attachments were supplied."
    : `The Signal message included ${item.attachments.length} attachment(s). Their bytes are not exposed in this first intake version; do not claim to have inspected them.`;
  return [
    `WorkItem ${item.id} was submitted through the authorized Signal Control Tower.`,
    "Work only inside the current repository. Preserve unrelated changes and follow its AGENTS.md instructions.",
    ...(item.mode === "question"
      ? [
        "This is a read-only codebase question. Do not edit files, create commits, or change repository state. Answer with concrete file references where useful.",
      ]
      : []),
    ...(item.mode === "question" ? [] : [
      `Before your final answer, run ${
        workspaceConfig.validateCommand.join(" ")
      } and keep working to resolve failures. Do not report the task complete while required validation fails; if an external blocker prevents a passing run, report that blocker plainly.`,
    ]),
    ...(item.mode === "question"
      ? []
      : ["Commit and push successful changes to the current Git branch before your final answer."]),
    "Do not wait for interactive approval; report any action that cannot be completed safely.",
    "To send a file back to Signal, put `ATTACHMENT: relative/path` on its own line in your final response. Only nominate files the user requested or that materially help answer the request.",
    attachmentNote,
    "",
    "User instruction:",
    item.instruction,
  ].join("\n");
}

function truncate(value: string, length = 1500): string {
  const trimmed = value.trim();
  return trimmed.length <= length ? trimmed : `${trimmed.slice(0, length - 1)}…`;
}

export function finalSummary(value: string, fallback: string): string {
  return value.trim() || fallback;
}

async function git(projectPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", projectPath, ...args], {
    encoding: "utf8",
    maxBuffer: 2_000_000,
  });
  return stdout.trim();
}

export class CodexWorkQueue {
  readonly #config: IntakeConfig;
  readonly #store: WorkItemStore;
  readonly #notify: QueueNotifier;
  #pending: WorkItem[] = [];
  #active: ActiveRun | undefined;

  constructor(config: IntakeConfig, store: WorkItemStore, notify: QueueNotifier) {
    this.#config = config;
    this.#store = store;
    this.#notify = notify;
  }

  enqueue(item: WorkItem): void {
    this.#pending.push(item);
    void this.#pump();
  }

  async cancel(id: string): Promise<"cancelled" | "not-running" | "unknown"> {
    const queuedIndex = this.#pending.findIndex((item) => item.id === id);
    if (queuedIndex >= 0) {
      const [item] = this.#pending.splice(queuedIndex, 1);
      if (!item) return "unknown";
      await this.#store.update(id, { status: "cancelled" });
      await this.#emit(item, { kind: "cancelled" });
      return "cancelled";
    }

    if (this.#active?.item.id === id) {
      this.#active.cancelling = true;
      const child = this.#active.child;
      if (child?.pid) {
        try {
          if (process.platform === "win32") child.kill("SIGTERM");
          else process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        const processId = child.pid;
        const forceKill = setTimeout(() => {
          if (this.#active?.child !== child || child.exitCode !== null) return;
          try {
            if (process.platform === "win32") child.kill("SIGKILL");
            else process.kill(-processId, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              process.stderr.write(
                `[signal-control-tower] force-cancel failed: ${(error as Error).message}\n`,
              );
            }
          }
        }, 5_000);
        forceKill.unref();
      }
      return "cancelled";
    }

    return this.#store.get(id) ? "not-running" : "unknown";
  }

  async #pump(): Promise<void> {
    if (this.#active) return;
    const item = this.#pending.shift();
    if (!item) return;
    this.#active = { item, child: undefined, cancelling: false };

    try {
      const result = await this.#run(item);
      if (this.#active.cancelling) {
        await this.#store.update(item.id, { status: "cancelled" });
        await this.#emit(item, { kind: "cancelled" });
      } else {
        await this.#store.update(item.id, { status: "completed", result });
        await this.#emit(item, { kind: "completed", result });
      }
    } catch (error) {
      if (this.#active.cancelling) {
        await this.#store.update(item.id, { status: "cancelled" });
        await this.#emit(item, { kind: "cancelled" });
      } else {
        const message = truncate((error as Error).message, 1000);
        await this.#store.update(item.id, { status: "failed", error: message });
        await this.#emit(item, { kind: "failed", error: message });
      }
    } finally {
      this.#active = undefined;
      void this.#pump();
    }
  }

  async #emit(item: WorkItem, event: QueueEvent): Promise<void> {
    try {
      await this.#notify(item, event);
    } catch (error) {
      process.stderr.write(
        `[signal-control-tower] could not deliver ${event.kind} update for ${item.id}: ${
          (error as Error).message
        }\n`,
      );
    }
  }

  async #run(item: WorkItem): Promise<WorkItemResult> {
    const workspaceConfig = this.#config.workspace;
    const baseCommit = await git(workspaceConfig.path, ["rev-parse", "HEAD"]);
    const workspace = workspaceConfig.path;
    await this.#store.update(item.id, { status: "running" });
    await this.#emit(item, { kind: "started", workspace });

    const codex = await this.#executeCodex(item, workspaceConfig, workspace);
    if (item.mode !== "question") await this.#validate(workspaceConfig, workspace);
    const artifacts = extractArtifactDeclarations(
      codex.summary || "Codex completed without a final answer.",
    );
    if (item.mode === "question") {
      return {
        summary: finalSummary(artifacts.summary, "Codex completed without a final answer."),
        ...(artifacts.paths.length > 0 ? { artifactPaths: artifacts.paths } : {}),
        filesChanged: 0,
        ...(codex.threadId ? { threadId: codex.threadId } : {}),
      };
    }
    const finalCommit = await git(workspace, ["rev-parse", "HEAD"]);
    const committedFiles = await git(workspace, ["diff", "--name-only", baseCommit, "HEAD"]);
    const workingFiles = await git(workspace, ["status", "--porcelain"]);
    const files = new Set([
      ...committedFiles.split("\n").filter(Boolean),
      ...workingFiles.split("\n").filter(Boolean).map((line) => line.slice(3)),
    ]);

    const result: WorkItemResult = {
      summary: finalSummary(artifacts.summary, "Codex completed without a final summary."),
      ...(artifacts.paths.length > 0 ? { artifactPaths: artifacts.paths } : {}),
      filesChanged: files.size,
      ...(finalCommit !== baseCommit ? { commit: finalCommit.slice(0, 12) } : {}),
      ...(codex.threadId ? { threadId: codex.threadId } : {}),
    };
    return result;
  }

  async #executeCodex(
    item: WorkItem,
    workspaceConfig: WorkspaceConfig,
    workspace: string,
  ): Promise<{ summary: string; threadId?: string }> {
    const args = buildCodexArguments({
      item,
      workspaceConfig,
      workspace,
      extraArgs: this.#config.codex.extraArgs,
      model: this.#config.codex.model,
      reasoningEffort: this.#config.codex.reasoningEffort,
      prompt: taskPrompt(item, workspaceConfig),
    });
    const child = spawn(this.#config.codex.executable, args, {
      cwd: workspace,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (this.#active) this.#active.child = child;

    let output = "";
    let errorOutput = "";
    let summary = "";
    let threadId: string | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      const lines = output.split("\n");
      output = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === "thread.started" && typeof event.thread_id === "string") {
            threadId = event.thread_id;
          }
          const eventItem = typeof event.item === "object" && event.item !== null
            ? event.item as Record<string, unknown>
            : undefined;
          if (
            event.type === "item.completed" &&
            eventItem?.type === "agent_message" &&
            typeof eventItem.text === "string"
          ) {
            summary = eventItem.text;
          }
        } catch {
          // Retain malformed/legacy stdout as a final-summary fallback.
          summary = line;
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      errorOutput = `${errorOutput}${chunk}`.slice(-8000);
    });

    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve(exitCode ?? 1));
    });
    if (code !== 0) {
      throw new Error(
        `codex exec exited with code ${code}: ${truncate(errorOutput || summary || output, 1500)}`,
      );
    }
    const response = { summary: summary || output.trim(), ...(threadId ? { threadId } : {}) };
    return response;
  }

  async #validate(workspaceConfig: WorkspaceConfig, workspace: string): Promise<void> {
    const [executable, ...args] = workspaceConfig.validateCommand;
    if (!executable) throw new Error("The configured validation command is empty.");
    try {
      await execFileAsync(executable, args, {
        cwd: workspace,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 2_000_000,
        timeout: 30 * 60_000,
      });
    } catch (error) {
      const output = error instanceof Error && "stdout" in error && "stderr" in error
        ? `${String(error.stdout)}\n${String(error.stderr)}`
        : error instanceof Error
        ? error.message
        : String(error);
      throw new Error(
        `Validation failed (${workspaceConfig.validateCommand.join(" ")}): ${
          truncate(output, 1500)
        }`,
      );
    }
  }
}
