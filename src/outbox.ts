import { mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { clearInterval, setInterval } from "node:timers";

interface GitCommit {
  shortOid: string;
  subject: string;
}

interface GitUpdate {
  localRef: string;
  remoteRef: string;
  commits: GitCommit[];
}

interface GitPrePushEvent {
  version: 1;
  kind: "git-pre-push";
  repository: string;
  remote: string;
  occurredAt: string;
  updates: GitUpdate[];
}

interface SignalDispatchEvent {
  version: 1;
  kind: "signal-dispatch";
  createdAt: string;
  title?: string;
  body: string;
}

type OutboxNotifier = (message: string) => void | Promise<void>;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function parseGitPrePushEvent(value: unknown): GitPrePushEvent {
  const event = object(value);
  if (event?.version !== 1 || event.kind !== "git-pre-push" || !Array.isArray(event.updates)) {
    throw new Error("Unsupported outbox event");
  }
  const updates = event.updates.slice(0, 20).map((value, updateIndex) => {
    const update = object(value);
    if (!update || !Array.isArray(update.commits)) throw new Error(`Invalid update ${updateIndex}`);
    const commits = update.commits.slice(0, 200).map((value, commitIndex) => {
      const commit = object(value);
      if (!commit) throw new Error(`Invalid commit ${commitIndex}`);
      return {
        shortOid: text(commit.shortOid, "commit oid", 64),
        subject: text(commit.subject, "commit subject"),
      };
    });
    return {
      localRef: text(update.localRef, "local ref"),
      remoteRef: text(update.remoteRef, "remote ref"),
      commits,
    };
  });
  return {
    version: 1,
    kind: "git-pre-push",
    repository: text(event.repository, "repository"),
    remote: text(event.remote, "remote"),
    occurredAt: text(event.occurredAt, "event time"),
    updates,
  };
}

function parseSignalDispatchEvent(value: unknown): SignalDispatchEvent {
  const event = object(value);
  if (event?.version !== 1 || event.kind !== "signal-dispatch") {
    throw new Error("Unsupported outbox event");
  }
  return {
    version: 1,
    kind: "signal-dispatch",
    createdAt: text(event.createdAt, "dispatch creation time"),
    ...(event.title === undefined ? {} : { title: text(event.title, "dispatch title") }),
    body: text(event.body, "dispatch body", 500_000),
  };
}

function shortRef(value: string): string {
  return value.replace(/^refs\/(?:heads|tags)\//u, "");
}

export function formatGitPrePushEvent(value: unknown): string {
  const event = parseGitPrePushEvent(value);
  const lines = [
    "⬆️ Git push starting",
    `repo: ${event.repository}`,
    `remote: ${event.remote}`,
    `time: ${event.occurredAt}`,
  ];
  for (const update of event.updates) {
    lines.push("", `${shortRef(update.localRef)} → ${shortRef(update.remoteRef)}`);
    for (const commit of update.commits) lines.push(`• ${commit.shortOid} ${commit.subject}`);
  }
  return lines.join("\n");
}

export function formatOutboxEvent(value: unknown): string {
  const event = object(value);
  if (event?.kind === "git-pre-push") return formatGitPrePushEvent(value);
  if (event?.kind === "signal-dispatch") {
    const dispatch = parseSignalDispatchEvent(value);
    return dispatch.title ? `${dispatch.title}\n\n${dispatch.body}` : dispatch.body;
  }
  throw new Error("Unsupported outbox event");
}

export class SignalOutbox {
  readonly #directory: string;
  readonly #rejectedDirectory: string;
  readonly #notify: OutboxNotifier;
  #timer: NodeJS.Timeout | undefined;
  #draining = false;

  constructor(directory: string, notify: OutboxNotifier) {
    this.#directory = directory;
    this.#rejectedDirectory = join(directory, "rejected");
    this.#notify = notify;
  }

  async start(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await this.#drain();
    this.#timer = setInterval(() => void this.#drain(), 1_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      const files = (await readdir(this.#directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name)
        .sort();
      for (const file of files) {
        const path = join(this.#directory, file);
        try {
          const event = JSON.parse(await readFile(path, "utf8")) as unknown;
          await this.#notify(formatOutboxEvent(event));
          await unlink(path);
        } catch (error) {
          if (
            error instanceof SyntaxError || (error as Error).message.startsWith("Invalid") ||
            (error as Error).message === "Unsupported outbox event"
          ) {
            await mkdir(this.#rejectedDirectory, { recursive: true, mode: 0o700 });
            await rename(path, join(this.#rejectedDirectory, file));
          } else {
            process.stderr.write(
              `[signal-control-tower] outbox delivery failed: ${(error as Error).message}\n`,
            );
            break;
          }
        }
      }
    } finally {
      this.#draining = false;
    }
  }
}
