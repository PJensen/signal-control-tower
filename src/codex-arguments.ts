import type { ProjectConfig, WorkItem } from "./types.ts";

interface CodexArgumentInput {
  item: WorkItem;
  project: ProjectConfig;
  workspace: string;
  extraArgs: string[];
  prompt: string;
}

export function buildCodexArguments(input: CodexArgumentInput): string[] {
  const allowWrite = input.item.mode !== "question" && input.project.allowWrite;
  return [
    "--ask-for-approval",
    "never",
    "--cd",
    input.workspace,
    "exec",
    "--json",
    "--sandbox",
    allowWrite ? "workspace-write" : "read-only",
    ...input.extraArgs,
    input.prompt,
  ];
}
