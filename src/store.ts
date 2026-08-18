import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkItemRecord } from "./types.ts";

interface PersistedState {
  version: 1;
  records: WorkItemRecord[];
}

export class WorkItemStore {
  readonly #path: string;
  readonly #directory: string;
  #records = new Map<string, WorkItemRecord>();
  #writeChain: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.#directory = directory;
    this.#path = join(directory, "work-items.json");
  }

  async load(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as PersistedState;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
        throw new Error("Unsupported work-item state format");
      }
      this.#records = new Map(parsed.records.map((record) => [record.item.id, record]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  all(): WorkItemRecord[] {
    return [...this.#records.values()].sort((a, b) =>
      b.item.createdAt.localeCompare(a.item.createdAt)
    );
  }

  get(id: string): WorkItemRecord | undefined {
    return this.#records.get(id);
  }

  findByMessageId(messageId: string): WorkItemRecord | undefined {
    return this.all().find((record) => record.item.source.messageId === messageId);
  }

  latestForSender(sender: string): WorkItemRecord | undefined {
    return this.all().find((record) => record.item.source.sender === sender);
  }

  async put(record: WorkItemRecord): Promise<void> {
    this.#records.set(record.item.id, record);
    await this.#persist();
  }

  async update(id: string, update: Omit<Partial<WorkItemRecord>, "item">): Promise<WorkItemRecord> {
    const current = this.#records.get(id);
    if (!current) throw new Error(`Unknown work item: ${id}`);
    const next: WorkItemRecord = { ...current, ...update, updatedAt: new Date().toISOString() };
    this.#records.set(id, next);
    await this.#persist();
    return next;
  }

  async interruptActiveQueue(): Promise<WorkItemRecord[]> {
    const interruptedAt = new Date().toISOString();
    const interrupted = this.all().filter((record) =>
      record.status === "queued" || record.status === "running"
    ).map((record) => ({
      ...record,
      status: "interrupted" as const,
      updatedAt: interruptedAt,
      error: record.status === "queued"
        ? "The intake daemon restarted before this item began; it was not resumed automatically."
        : "The intake daemon stopped while this item was running; it was not resumed automatically.",
    }));
    if (!interrupted.length) return interrupted;

    for (const record of interrupted) this.#records.set(record.item.id, record);
    await this.#persist();
    return interrupted;
  }

  async #persist(): Promise<void> {
    const state: PersistedState = { version: 1, records: this.all() };
    const temporary = `${this.#path}.tmp`;
    this.#writeChain = this.#writeChain.then(async () => {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#path);
    });
    await this.#writeChain;
  }
}
