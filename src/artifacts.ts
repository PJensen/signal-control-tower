import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const MAX_ARTIFACTS = 5;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

export function extractArtifactDeclarations(summary: string): { summary: string; paths: string[] } {
  const paths: string[] = [];
  const retained: string[] = [];
  for (const line of summary.split("\n")) {
    const match = line.match(/^ATTACHMENT:\s*(.+?)\s*$/iu);
    if (!match) {
      retained.push(line);
      continue;
    }
    const path = match[1]?.trim().replace(/^`|`$/gu, "");
    if (path && !paths.includes(path)) paths.push(path);
  }
  return { summary: retained.join("\n").trim(), paths: paths.slice(0, MAX_ARTIFACTS) };
}

export async function validateArtifactPaths(workspace: string, paths: string[]): Promise<string[]> {
  const root = await realpath(workspace);
  const validated: string[] = [];
  for (const declared of paths.slice(0, MAX_ARTIFACTS)) {
    if (isAbsolute(declared) || declared.includes("\0")) {
      throw new Error(`Attachment path must be relative to the workspace: ${declared}`);
    }
    const path = await realpath(resolve(root, declared));
    const inside = relative(root, path);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`Attachment path escapes the workspace: ${declared}`);
    }
    const stats = await lstat(path);
    if (!stats.isFile()) throw new Error(`Attachment is not a regular file: ${declared}`);
    if (stats.size > MAX_ARTIFACT_BYTES) throw new Error(`Attachment exceeds 25 MB: ${declared}`);
    validated.push(path);
  }
  return validated;
}
