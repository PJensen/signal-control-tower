import { createSetupConfig, parseSignalAccounts, parseSignalGroups } from "../src/setup.mjs";

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}

Deno.test("setup parses signal-cli discovery output", () => {
  assertEquals(
    parseSignalAccounts(JSON.stringify([
      { number: "+15555550100" },
      "+15555550101",
    ])),
    [
      { account: "+15555550100" },
      { account: "+15555550101" },
    ],
  );
  assertEquals(
    parseSignalGroups(JSON.stringify([
      { id: "mfiq-id", name: "MFIQ.ai", isMember: true, isBlocked: false },
    ])),
    [
      { id: "mfiq-id", name: "MFIQ.ai", isMember: true, isBlocked: false },
    ],
  );
});

Deno.test("setup emits least-privilege MFIQ configuration", () => {
  const config = createSetupConfig({
    account: "+15555550100",
    allowedSender: "+15555550100",
    group: { id: "mfiq-id", name: "MFIQ.ai" },
    signalExecutable: "/usr/local/bin/signal-cli",
    codexExecutable: "/home/pete/.local/bin/codex",
    entireExecutable: "entire",
    projectPath: "/src/mfiq.ai",
    enableRelease: false,
  });
  assertEquals(config.codex, {
    executable: "/home/pete/.local/bin/codex",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    extraArgs: [],
  });
  assertEquals(config.entire, { executable: "entire" });
  assertEquals(config.projects.mfiq, {
    path: "/src/mfiq.ai",
    allowWrite: true,
    baseRef: "HEAD",
    isolatedWorktree: true,
    validateCommand: ["npm", "run", "validate"],
  });
});
