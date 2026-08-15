import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { IncomingSignalMessage } from "./types.ts";

export interface RecordedFeatureRequest {
  created: boolean;
  relativePath: string;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 64)
    .replace(/-$/u, "");
  return normalized || "feature-request";
}

export async function recordFeatureRequest(
  projectPath: string,
  message: IncomingSignalMessage,
  request: string,
): Promise<RecordedFeatureRequest> {
  const receivedAt = new Date(message.timestamp);
  if (Number.isNaN(receivedAt.valueOf())) throw new Error("The Signal timestamp is invalid.");

  const projectRoot = await realpath(projectPath);
  const requestedDirectory = join(projectRoot, "docs", "features");
  await mkdir(requestedDirectory, { recursive: true, mode: 0o755 });
  const directory = await realpath(requestedDirectory);
  const withinProject = relative(projectRoot, directory);
  if (withinProject === ".." || withinProject.startsWith(`..${sep}`) || isAbsolute(withinProject)) {
    throw new Error("The feature request directory resolves outside the registered project.");
  }

  const timestamp = receivedAt.toISOString();
  const compactTimestamp = timestamp.replaceAll(/[-:.]/gu, "");
  const messageId = `${message.groupId}:${message.sender}:${message.timestamp}`;
  const suffix = createHash("sha256").update(messageId).digest("hex").slice(0, 8);
  const filename = `${compactTimestamp}-${suffix}-${slug(request.split("\n", 1)[0] ?? request)}.md`;
  const relativePath = `docs/features/${filename}`;
  const contents = [
    "----",
    `sender: ${quoted(message.sender)}`,
    `timestamp: ${quoted(timestamp)}`,
    "other_metadata:",
    "  transport: signal",
    `  conversation: ${quoted(message.groupId)}`,
    `  message_id: ${quoted(messageId)}`,
    `  attachment_count: ${message.attachments.length}`,
    "----",
    request.trim(),
    "",
  ].join("\n");

  try {
    await writeFile(join(directory, filename), contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    return { created: true, relativePath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { created: false, relativePath };
    throw error;
  }
}
