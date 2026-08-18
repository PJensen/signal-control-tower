import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface ArchivedAttachment {
  sourcePath: string;
  archivePath: string;
  bytes: number;
  sha256: string;
}

export class EventLog {
  readonly #directory: string;
  readonly #eventsPath: string;
  #pending: Promise<void> = Promise.resolve();

  constructor(stateDirectory: string) {
    this.#directory = join(stateDirectory, "logs");
    this.#eventsPath = join(this.#directory, "events.jsonl");
  }

  record(
    kind: string,
    data: Record<string, unknown>,
    attachmentPaths: string[] = [],
  ): Promise<void> {
    const operation = this.#pending.then(async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const attachments: ArchivedAttachment[] = [];
      const attachmentErrors: Array<{ sourcePath: string; error: string }> = [];
      for (const sourcePath of attachmentPaths) {
        try {
          attachments.push(await this.#archive(sourcePath));
        } catch (error) {
          attachmentErrors.push({ sourcePath, error: (error as Error).message });
        }
      }
      const event = {
        version: 1,
        occurredAt: new Date().toISOString(),
        kind,
        data,
        ...(attachments.length ? { attachments } : {}),
        ...(attachmentErrors.length ? { attachmentErrors } : {}),
      };
      const file = await open(this.#eventsPath, "a", 0o600);
      try {
        await file.write(`${JSON.stringify(event)}\n`);
      } finally {
        await file.close();
      }
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  async #archive(sourcePath: string): Promise<ArchivedAttachment> {
    const content = await readFile(sourcePath);
    const attachmentDirectory = join(this.#directory, "attachments");
    await mkdir(attachmentDirectory, { recursive: true, mode: 0o700 });
    const archivePath = join(
      attachmentDirectory,
      `${new Date().toISOString().replaceAll(/[-:.]/gu, "")}-${randomUUID()}-${
        basename(sourcePath)
      }`,
    );
    await copyFile(sourcePath, archivePath);
    await Deno.chmod(archivePath, 0o600);
    return {
      sourcePath,
      archivePath,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  }
}
