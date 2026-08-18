import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface EntireDispatchResult {
  output: string;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function generateEntireDispatch(
  executable: string,
  projectPath: string,
  args: string[],
): Promise<EntireDispatchResult> {
  const startedAt = Date.now();
  const result = await execFileAsync(executable, ["dispatch", ...args], {
    cwd: projectPath,
    encoding: "utf8",
    maxBuffer: 4_000_000,
    timeout: 10 * 60_000,
  });
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  return {
    output: stdout || stderr || "Entire completed without dispatch output.",
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
  };
}

export function signalMessageBlocks(message: string, limit = 1700): string[] {
  const remainingBlocks: string[] = [];
  let remaining = message.trim();
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut < Math.floor(limit / 2)) cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    remainingBlocks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) remainingBlocks.push(remaining);
  return remainingBlocks.length > 0 ? remainingBlocks : ["No message output was produced."];
}
