import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function generateActivityDispatch(
  executable: string,
  projectPath: string,
  args: string[],
): Promise<string> {
  const result = await execFileAsync(executable, ["dispatch", ...args], {
    cwd: projectPath,
    encoding: "utf8",
    maxBuffer: 4_000_000,
    timeout: 10 * 60_000,
  });
  return result.stdout.trim() || result.stderr.trim() ||
    "Entire completed without dispatch output.";
}

export function activityMessageBlocks(dispatch: string, limit = 1700): string[] {
  const remainingBlocks: string[] = [];
  let remaining = dispatch.trim();
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut < Math.floor(limit / 2)) cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    remainingBlocks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) remainingBlocks.push(remaining);
  return remainingBlocks.length > 0
    ? remainingBlocks
    : ["Entire completed without dispatch output."];
}
