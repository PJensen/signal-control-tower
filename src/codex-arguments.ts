import type { WorkItem, WorkspaceConfig } from "./types.ts";

interface CodexArgumentInput {
  item: WorkItem;
  workspaceConfig: WorkspaceConfig;
  workspace: string;
  extraArgs: string[];
  model: string;
  reasoningEffort: string;
  prompt: string;
}

export function buildCodexArguments(input: CodexArgumentInput): string[] {
  const allowWrite = input.item.mode !== "question" && input.workspaceConfig.allowWrite;
  return [
    "--ask-for-approval",
    "never",
    "--cd",
    input.workspace,
    "exec",
    "--json",
    "--sandbox",
    allowWrite ? "workspace-write" : "read-only",
    "--model",
    input.model,
    "--config",
    `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`,
    ...input.extraArgs,
    input.prompt,
  ];
}
