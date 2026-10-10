import { parseIntakeCommand, signalNotificationToMessage } from "../src/protocol.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}

Deno.test("parseIntakeCommand parses multiline workspace tasks", () => {
  assertEquals(parseIntakeCommand("/codex\nFix the release workflow"), {
    kind: "codex",
    instruction: "Fix the release workflow",
  });
});

Deno.test("parseIntakeCommand parses ship", () => {
  assertEquals(parseIntakeCommand("/ship"), { kind: "ship" });
});

Deno.test("parseIntakeCommand keeps questions read-only", () => {
  assertEquals(parseIntakeCommand("/ask Why is this failing?"), {
    kind: "ask",
    question: "Why is this failing?",
  });
});

Deno.test("parseIntakeCommand accepts a first-line question with follow-up paragraphs", () => {
  assertEquals(parseIntakeCommand("/ask Can this work?\nWhat persists?\n\nWhat is next?"), {
    kind: "ask",
    question: "Can this work?\nWhat persists?\n\nWhat is next?",
  });
});

Deno.test("parseIntakeCommand maps dispatch directly to Entire arguments", () => {
  assertEquals(parseIntakeCommand("/dispatch --since 7d --voice neutral"), {
    kind: "dispatch",
    args: ["--since", "7d", "--voice", "neutral", "--local"],
  });
});

Deno.test("parseIntakeCommand parses context capture lifecycle commands", () => {
  assertEquals(parseIntakeCommand("/capture start Rent roll workflow"), {
    kind: "capture",
    action: "start",
    title: "Rent roll workflow",
  });
  assertEquals(parseIntakeCommand("/capture status"), {
    kind: "capture",
    action: "status",
  });
  assertEquals(parseIntakeCommand("/capture done"), {
    kind: "capture",
    action: "done",
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
