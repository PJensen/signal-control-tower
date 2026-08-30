import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { IncomingSignalMessage } from "./types.ts";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RecordedFeatureRequest {
  created: boolean;
  relativePath: string;
  issueUrl?: string;
  issueError?: string;
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
    const title = request.split("\n", 1)[0]?.trim().slice(0, 256) || "Feature request";
    const provenance = [
      "## Request",
      request.trim(),
      "",
      "## Signal provenance",
      `- Sender: ${message.sender}`,
      `- Conversation: ${message.groupId}`,
      `- Timestamp: ${timestamp}`,
    ].join("\n");
    try {
      const remote = (await execFileAsync("git", ["remote", "get-url", "origin"], {
        cwd: projectRoot,
        encoding: "utf8",
      })).stdout.trim();
      const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/u);
      if (!match?.[1]) throw new Error("origin is not a GitHub repository");
      const issue = await execFileAsync("gh", [
        "issue",
        "create",
        "--repo",
        match[1],
        "--title",
        title,
        "--body",
        provenance,
      ], { cwd: projectRoot, encoding: "utf8" });
      return { created: true, relativePath, issueUrl: issue.stdout.trim() };
    } catch (error) {
      return { created: true, relativePath, issueError: (error as Error).message };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { created: false, relativePath };
    throw error;
  }
}
