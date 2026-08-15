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
