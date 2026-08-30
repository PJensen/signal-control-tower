import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IntakeConfig } from "./types.ts";

const execFileAsync = promisify(execFile);
export interface ShipResult {
  commit: string;
  stash?: string;
  steps: string[];
  output: string;
}

export type ShipProgress = (message: string) => Promise<void>;

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI_OSC = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, "gu");
const ANSI_SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, "gu");
const ANSI_CSI = new RegExp(`(?:${ESC}\\[|${String.fromCharCode(0x9b)})[0-?]*[ -/]*[@-~]`, "gu");
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x08)}${String.fromCharCode(0x0b)}${
    String.fromCharCode(0x0c)
  }${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
  "gu",
);

export function cleanCommandOutput(output: string): string {
  const styles = new Set<"bold" | "italic" | "strike">();
  const markers = { bold: "**", italic: "*", strike: "~~" } as const;
  const closeStyles = (closing: Set<"bold" | "italic" | "strike">): string =>
    [...closing].reverse().map((style) => markers[style]).join("");
  const openStyles = (opening: Set<"bold" | "italic" | "strike">): string =>
    (["bold", "italic", "strike"] as const)
      .filter((style) => opening.has(style))
      .map((style) => markers[style])
      .join("");
  const styled = output.replace(ANSI_SGR, (_sequence, parameters: string) => {
    const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
    const closing = new Set<"bold" | "italic" | "strike">();
    const opening = new Set<"bold" | "italic" | "strike">();
    for (const code of codes) {
      if (code === 0) {
        for (const style of styles) closing.add(style);
        styles.clear();
      } else if (code === 1) {
        if (styles.has("bold")) closing.add("bold");
        styles.add("bold");
        opening.add("bold");
      } else if (code === 22) {
        if (styles.delete("bold")) closing.add("bold");
      } else if (code === 3) {
        if (styles.has("italic")) closing.add("italic");
        styles.add("italic");
        opening.add("italic");
      } else if (code === 23) {
        if (styles.delete("italic")) closing.add("italic");
      } else if (code === 9) {
        if (styles.has("strike")) closing.add("strike");
        styles.add("strike");
        opening.add("strike");
      } else if (code === 29) {
        if (styles.delete("strike")) closing.add("strike");
      }
    }
    return `${closeStyles(closing)}${openStyles(opening)}`;
  });
  const closed = styled + closeStyles(new Set(styles));
  return closed
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replaceAll("\r", "")
    .replaceAll("\\_", "_")
    .replace(CONTROL_CHARS, "");
}

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 2_000_000,
    timeout: 30 * 60_000,
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
function failureText(error: unknown): string {
  const value = error as { message?: string; stdout?: string; stderr?: string };
  return [value.message, value.stdout, value.stderr].filter(Boolean).join("\n");
}
function authFailure(error: unknown): boolean {
  return /auth|credential|unauthori[sz]ed|forbidden|login/u.test(failureText(error));
}

export class WorkItemReleaseManager {
  readonly #config: IntakeConfig;
  #active = false;
  constructor(config: IntakeConfig) {
    this.#config = config;
  }

  async ship(onProgress?: ShipProgress): Promise<ShipResult> {
    if (this.#active) throw new Error("Another ship operation is already running.");
    this.#active = true;
    const workspace = this.#config.workspace.path;
    let stash: string | undefined;
    const steps: string[] = [];
    try {
      await onProgress?.("Refreshing main…");
      const status = (await run("git", ["status", "--porcelain"], workspace)).stdout;
      if (status) {
        const result = await run("git", [
          "stash",
          "push",
          "--include-untracked",
          "-m",
          `signal-control-tower ${new Date().toISOString()}`,
        ], workspace);
        stash = result.stdout.match(/stash@\{\d+\}/u)?.[0] ??
          (await run("git", ["stash", "list", "-1", "--format=%gd"], workspace)).stdout;
      }
      await run("git", ["checkout", "main"], workspace);
      await run("git", ["fetch", "origin"], workspace);
      await run("git", ["reset", "--hard", "origin/main"], workspace);
      await run("git", ["pull", "--ff-only", "origin", "main"], workspace);
      const deployCommand = this.#config.workspace.shipCommands.at(-1);
      if (!deployCommand) {
        throw new Error("workspace.shipCommands must include a deployment command.");
      }
      for (const [command, ...args] of this.#config.workspace.shipCommands.slice(0, -1)) {
        const label = [command, ...args].join(" ");
        await onProgress?.(`Running ${label}…`);
        await run(command, args, workspace);
        steps.push(label);
      }
      await onProgress?.("Deploying…");
      steps.push(deployCommand.join(" "));
      let deploy: { stdout: string; stderr: string } | undefined;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          deploy = await run(deployCommand[0]!, deployCommand.slice(1), workspace);
          break;
        } catch (error) {
          if (!authFailure(error) || attempt === 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        }
      }
      const commit = (await run("git", ["rev-parse", "HEAD"], workspace)).stdout;
      return {
        commit,
        ...(stash ? { stash } : {}),
        steps,
        output: cleanCommandOutput([deploy?.stdout, deploy?.stderr].filter(Boolean).join("\n")),
      };
    } finally {
      this.#active = false;
    }
  }
}
