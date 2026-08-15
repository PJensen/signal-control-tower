import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { IntakeConfig } from "./types.ts";

interface JsonRpcResponse {
  id?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

type NotificationHandler = (value: unknown) => void | Promise<void>;

export class SignalJsonRpc {
  readonly #config: IntakeConfig["signal"];
  readonly #onNotification: NotificationHandler;
  #child: ChildProcessWithoutNullStreams | undefined;
  #sequence = 0;
  #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(config: IntakeConfig["signal"], onNotification: NotificationHandler) {
    this.#config = config;
    this.#onNotification = onNotification;
  }

  async start(): Promise<void> {
    const args = [
      ...(this.#config.dataDirectory ? ["--data-dir", this.#config.dataDirectory] : []),
      "--account",
      this.#config.account,
      "jsonRpc",
      "--ignore-stories",
      "--ignore-avatars",
      "--ignore-stickers",
    ];
    const child = spawn(this.#config.executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => process.stderr.write(`[signal-cli] ${chunk}`));
    child.once("error", (error) => this.#rejectAll(error));
    child.once("exit", (code, signal) => {
      this.#child = undefined;
      this.#rejectAll(
        new Error(`signal-cli exited (code=${String(code)}, signal=${String(signal)})`),
      );
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => void this.#handleLine(line));

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const child = this.#child;
    if (!child?.stdin.writable) throw new Error("signal-cli is not running");
    const id = `mfiq-${++this.#sequence}`;
    const payload = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return response;
  }

  async listGroups(): Promise<unknown> {
    return this.request("listGroups");
  }

  async sendGroupMessage(message: string): Promise<void> {
    await this.request("send", { groupId: this.#config.groupId, message });
  }

  stop(): void {
    this.#child?.kill("SIGTERM");
  }

  async #handleLine(line: string): Promise<void> {
    let value: JsonRpcResponse;
    try {
      value = JSON.parse(line) as JsonRpcResponse;
    } catch {
      process.stderr.write("[signal-control-tower] ignored non-JSON signal-cli output\n");
      return;
    }

    if (value.id !== undefined) {
      const pending = this.#pending.get(String(value.id));
      if (!pending) return;
      this.#pending.delete(String(value.id));
      if (value.error) {
        pending.reject(
          new Error(value.error.message ?? `Signal JSON-RPC error ${String(value.error.code)}`),
        );
      } else {
        pending.resolve(value.result);
      }
      return;
    }

    try {
      await this.#onNotification(value);
    } catch (error) {
      process.stderr.write(
        `[signal-control-tower] notification failed: ${(error as Error).message}\n`,
      );
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
