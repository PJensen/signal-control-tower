import { signalMessageBlocks } from "../src/entire.ts";
import { finalSummary } from "../src/codex-runner.ts";

function assert(condition: boolean): void {
  if (!condition) throw new Error("Expected condition to be true");
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}

Deno.test("longform responses retain the complete Codex final response", () => {
  const response = `  ${"long response ".repeat(200)}  `;

  assertEquals(finalSummary(response, "fallback"), response.trim());
  assertEquals(finalSummary("  ", "fallback"), "fallback");
});

Deno.test("longform responses split into ordered Signal-safe messages without losing text", () => {
  const paragraphs = Array.from(
    { length: 40 },
    (_, index) => `Paragraph ${index + 1}: ${"detail ".repeat(12).trim()}`,
  );
  const response = paragraphs.join("\n\n");
  const blocks = signalMessageBlocks(response, 500);

  assert(blocks.length > 1);
  assert(blocks.every((block) => block.length <= 500));
  assertEquals(blocks.join("\n\n"), response);
});
