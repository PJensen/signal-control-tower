import { parseIntakeCommand, signalNotificationToMessage } from "../src/protocol.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}

Deno.test("parseIntakeCommand parses multiline project tasks", () => {
  assertEquals(parseIntakeCommand("/codex app\nFix the release workflow"), {
    kind: "codex",
    project: "app",
    instruction: "Fix the release workflow",
  });
});

Deno.test("parseIntakeCommand keeps questions read-only", () => {
  assertEquals(parseIntakeCommand("/ask Why is this failing?"), {
    kind: "ask",
    question: "Why is this failing?",
  });
});

Deno.test("signalNotificationToMessage normalizes receive notifications", () => {
  assertEquals(
    signalNotificationToMessage({
      method: "receive",
      params: {
        result: {
          envelope: {
            sourceNumber: "+15555550101",
            dataMessage: {
              timestamp: 1_700_000_000_000,
              message: "/help",
              groupInfo: { groupId: "group-id" },
              attachments: [{ uuid: "attachment-id", filename: "log.txt" }],
            },
          },
        },
      },
    }),
    {
      sender: "+15555550101",
      groupId: "group-id",
      timestamp: 1_700_000_000_000,
      message: "/help",
      attachments: [{ id: "attachment-id", filename: "log.txt" }],
    },
  );
});
