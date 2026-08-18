import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";

import type { IncomingSignalMessage, WorkItemAttachment } from "./types.ts";

interface CapturedAttachment extends WorkItemAttachment {
  archivedPath?: string;
  sha256?: string;
  archiveError?: string;
}

interface CapturedMessage {
  messageId: string;
  timestamp: number;
  text: string;
  attachments: CapturedAttachment[];
}

export interface CaptureSession {
  id: string;
  project: string;
  title?: string;
  sender: string;
  conversation: string;
  startedAt: string;
  messages: CapturedMessage[];
}

interface PersistedCaptures {
  version: 1;
  active: CaptureSession[];
}

export interface CompletedCapture {
  id: string;
  relativePath: string;
  messageCount: number;
  attachmentCount: number;
}

function sessionKey(sender: string, conversation: string): string {
  return `${conversation}:${sender}`;
}

function safeFilename(value: string): string {
  const extension = extname(value).slice(0, 20);
  const stem = basename(value, extname(value)).replace(/[^a-zA-Z0-9._-]+/gu, "-").slice(0, 80);
  return `${stem || "attachment"}${extension}`;
}

function slug(value: string): string {
  return value.normalize("NFKD").replace(/\p{Mark}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 64) || "context-capture";
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

export class ContextCaptureStore {
  readonly #stateDirectory: string;
  readonly #path: string;
  #active = new Map<string, CaptureSession>();
  #writeChain: Promise<void> = Promise.resolve();

  constructor(stateDirectory: string) {
    this.#stateDirectory = join(stateDirectory, "captures");
    this.#path = join(this.#stateDirectory, "sessions.json");
  }

  async load(): Promise<void> {
    await mkdir(this.#stateDirectory, { recursive: true, mode: 0o700 });
    try {
      const state = JSON.parse(await readFile(this.#path, "utf8")) as PersistedCaptures;
      if (state.version !== 1 || !Array.isArray(state.active)) {
        throw new Error("Unsupported context-capture state format");
      }
      this.#active = new Map(state.active.map((session) => [
        sessionKey(session.sender, session.conversation),
        session,
      ]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  activeFor(sender: string, conversation: string): CaptureSession | undefined {
    return this.#active.get(sessionKey(sender, conversation));
  }

  async start(
    sender: string,
    conversation: string,
    project: string,
    title?: string,
  ): Promise<CaptureSession> {
    const key = sessionKey(sender, conversation);
    if (this.#active.has(key)) throw new Error("You already have an active context capture.");
    const session: CaptureSession = {
      id: `cap-${new Date().toISOString().replaceAll(/[-:]/gu, "").slice(0, 13)}-${
        randomUUID().replaceAll("-", "").slice(0, 6)
      }`,
      project,
      ...(title ? { title } : {}),
      sender,
      conversation,
      startedAt: new Date().toISOString(),
      messages: [],
    };
    this.#active.set(key, session);
    await this.#persist();
    return session;
  }

  async append(message: IncomingSignalMessage): Promise<CaptureSession | undefined> {
    const session = this.activeFor(message.sender, message.groupId);
    if (!session) return undefined;
    const messageId = `${message.groupId}:${message.sender}:${message.timestamp}`;
    if (session.messages.some((entry) => entry.messageId === messageId)) return session;

    const attachments: CapturedAttachment[] = [];
    for (const [index, attachment] of message.attachments.entries()) {
      const captured: CapturedAttachment = { ...attachment };
      if (attachment.path) {
        try {
          const content = await readFile(attachment.path);
          const archiveDirectory = join(this.#stateDirectory, session.id, "attachments");
          await mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
          const archivePath = join(
            archiveDirectory,
            `${String(session.messages.length + 1).padStart(4, "0")}-${index + 1}-${
              safeFilename(attachment.filename ?? basename(attachment.path))
            }`,
          );
          await copyFile(attachment.path, archivePath);
          await Deno.chmod(archivePath, 0o600);
          captured.archivedPath = archivePath;
          captured.sha256 = createHash("sha256").update(content).digest("hex");
        } catch (error) {
          captured.archiveError = (error as Error).message;
        }
      }
      attachments.push(captured);
    }
    session.messages.push({
      messageId,
      timestamp: message.timestamp,
      text: message.message,
      attachments,
    });
    await this.#persist();
    return session;
  }

  async cancel(sender: string, conversation: string): Promise<CaptureSession | undefined> {
    const key = sessionKey(sender, conversation);
    const session = this.#active.get(key);
    if (!session) return undefined;
    this.#active.delete(key);
    await this.#persist();
    return session;
  }

  async complete(
    sender: string,
    conversation: string,
    projectPath: string,
  ): Promise<CompletedCapture | undefined> {
    const session = this.activeFor(sender, conversation);
    if (!session) return undefined;
    const projectRoot = await realpath(projectPath);
    const outputDirectory = join(projectRoot, "docs", "context", "inbox");
    await mkdir(outputDirectory, { recursive: true, mode: 0o755 });
    const resolvedOutput = await realpath(outputDirectory);
    const withinProject = relative(projectRoot, resolvedOutput);
    if (
      withinProject === ".." || withinProject.startsWith(`..${sep}`) || isAbsolute(withinProject)
    ) {
      throw new Error("The context directory resolves outside the registered project.");
    }

    const assetDirectory = join(resolvedOutput, "assets", session.id);
    const attachmentLinks = new Map<string, string>();
    for (const message of session.messages) {
      for (const [index, attachment] of message.attachments.entries()) {
        if (!attachment.archivedPath) continue;
        await mkdir(assetDirectory, { recursive: true, mode: 0o755 });
        const filename = `${message.timestamp}-${index + 1}-${
          safeFilename(attachment.filename ?? basename(attachment.archivedPath))
        }`;
        await copyFile(attachment.archivedPath, join(assetDirectory, filename));
        attachmentLinks.set(attachment.archivedPath, `assets/${session.id}/${filename}`);
      }
    }

    const completedAt = new Date().toISOString();
    const title = session.title ?? session.messages[0]?.text.split("\n", 1)[0] ?? "Context capture";
    const filename = `${session.startedAt.slice(0, 10)}-${session.id}-${slug(title)}.md`;
    const relativePath = `docs/context/inbox/${filename}`;
    const attachmentCount = session.messages.reduce(
      (count, item) => count + item.attachments.length,
      0,
    );
    const lines = [
      "---",
      `capture_id: ${quoted(session.id)}`,
      `project: ${quoted(session.project)}`,
      `sender: ${quoted(session.sender)}`,
      `conversation: ${quoted(session.conversation)}`,
      `started_at: ${quoted(session.startedAt)}`,
      `completed_at: ${quoted(completedAt)}`,
      `message_count: ${session.messages.length}`,
      `attachment_count: ${attachmentCount}`,
      "status: inbox",
      "---",
      "",
      `# ${title}`,
      "",
      "> Verbatim Signal capture. Interpretations and decisions must be recorded separately.",
      "",
      "## Source transcript",
      "",
    ];
    for (const entry of session.messages) {
      lines.push(
        `### ${new Date(entry.timestamp).toISOString()} — ${session.sender}`,
        "",
        entry.text,
        "",
      );
      for (const attachment of entry.attachments) {
        const link = attachment.archivedPath
          ? attachmentLinks.get(attachment.archivedPath)
          : undefined;
        const label = attachment.filename ?? attachment.id;
        lines.push(
          link
            ? `- Attachment: [${label}](${link})`
            : `- Attachment: ${label} (content unavailable)`,
        );
        if (attachment.sha256) lines.push(`  - SHA-256: \`${attachment.sha256}\``);
        if (attachment.archiveError) {
          lines.push(`  - Archive error: ${attachment.archiveError}`);
        }
      }
      if (entry.attachments.length) lines.push("");
    }
    await writeFile(join(resolvedOutput, filename), `${lines.join("\n")}\n`, {
      flag: "wx",
      mode: 0o644,
    });
    this.#active.delete(sessionKey(sender, conversation));
    await this.#persist();
    return { id: session.id, relativePath, messageCount: session.messages.length, attachmentCount };
  }

  async #persist(): Promise<void> {
    const state: PersistedCaptures = { version: 1, active: [...this.#active.values()] };
    const temporary = `${this.#path}.tmp`;
    this.#writeChain = this.#writeChain.then(async () => {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#path);
    });
    await this.#writeChain;
  }
}
