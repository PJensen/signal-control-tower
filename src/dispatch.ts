import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface QueuedSignalDispatch {
  id: string;
  path: string;
}

export async function queueSignalDispatch(
  stateDirectory: string,
  body: string,
  title?: string,
): Promise<QueuedSignalDispatch> {
  const normalizedBody = body.trim();
  if (!normalizedBody) throw new Error("The dispatch body is empty.");
  if (normalizedBody.length > 500_000) {
    throw new Error("The dispatch body exceeds 500,000 characters.");
  }
  const normalizedTitle = title?.trim();
  if (normalizedTitle && normalizedTitle.length > 500) {
    throw new Error("The dispatch title exceeds 500 characters.");
  }

  const directory = join(stateDirectory, "outbox");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replaceAll(/[-:.]/gu, "")}-${randomUUID()}`;
  const filename = `${id}.json`;
  const path = join(directory, filename);
  const temporaryPath = join(directory, `.${filename}.tmp`);
  const event = {
    version: 1,
    kind: "signal-dispatch",
    createdAt,
    ...(normalizedTitle ? { title: normalizedTitle } : {}),
    body: normalizedBody,
  };
  await writeFile(temporaryPath, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  return { id, path };
}
