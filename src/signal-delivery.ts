import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface QueuedSignalDelivery {
  id: string;
  path: string;
}

export async function queueSignalDelivery(
  stateDirectory: string,
  body: string,
  title?: string,
  attachmentPath?: string,
): Promise<QueuedSignalDelivery> {
  const normalizedBody = body.trim();
  if (!normalizedBody) throw new Error("The delivery body is empty.");
  if (normalizedBody.length > 500_000) {
    throw new Error("The delivery body exceeds 500,000 characters.");
  }
  const normalizedTitle = title?.trim();
  if (normalizedTitle && normalizedTitle.length > 500) {
    throw new Error("The delivery title exceeds 500 characters.");
  }

  const directory = join(stateDirectory, "outbox");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replaceAll(/[-:.]/gu, "")}-${randomUUID()}`;
  const filename = `${id}.json`;
  const path = join(directory, filename);
  const temporaryPath = join(directory, `.${filename}.tmp`);
  const attachments: string[] = [];
  if (attachmentPath) {
    const source = await lstat(attachmentPath);
    if (!source.isFile()) throw new Error("The delivery attachment must be a regular file.");
    if (source.size > 25 * 1024 * 1024) {
      throw new Error("The delivery attachment exceeds 25 MB.");
    }
    const attachmentDirectory = `${path}.attachments`;
    await mkdir(attachmentDirectory, { mode: 0o700 });
    const spooledPath = join(attachmentDirectory, basename(attachmentPath));
    await copyFile(attachmentPath, spooledPath);
    attachments.push(spooledPath);
  }
  const event = {
    version: 1,
    kind: "signal-delivery",
    createdAt,
    ...(normalizedTitle ? { title: normalizedTitle } : {}),
    body: normalizedBody,
    attachments,
  };
  await writeFile(temporaryPath, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  return { id, path };
}
