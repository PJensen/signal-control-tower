import { buildCodexArguments } from "../src/codex-arguments.ts";

function assert(condition: boolean): void {
  if (!condition) throw new Error("Expected condition to be true");
}

Deno.test("Codex tasks select Terra at medium reasoning effort", () => {
  const args = buildCodexArguments({
    item: {
      id: "work-1",
      instruction: "Fix the test",
      attachments: [],
      source: {
        transport: "signal",
        sender: "+15555550100",
        conversation: "group",
        messageId: "1",
        timestamp: 1,
      },
      createdAt: "2026-08-17T00:00:00.000Z",
    },
    workspaceConfig: {
      path: "/repo",
      allowWrite: true,
      validateCommand: ["npm", "run", "validate"],
      shipCommands: [["npm", "run", "deploy"]],
    },
    workspace: "/repo/worktree",
    extraArgs: [],
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    prompt: "Fix the test",
  });

  assert(args.includes("--model"));
  assert(args[args.indexOf("--model") + 1] === "gpt-5.6-terra");
  assert(args.includes('model_reasoning_effort="medium"'));
});
