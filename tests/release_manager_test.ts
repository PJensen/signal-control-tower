import { cleanCommandOutput } from "../src/release-manager.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}

Deno.test("ship output removes terminal control sequences", () => {
  assertEquals(
    cleanCommandOutput("\u001b[22m\u001b[2mtest\\_output\u001b[39m\u001b[0m\r\nnext"),
    "test_output\nnext",
  );
});

Deno.test("ship failures remove terminal control sequences", () => {
  assertEquals(
    cleanCommandOutput(
      "Command failed: npm run test\n\u001b[31m\u001b[1mFailed Tests\u001b[22m\u001b[39m\nfailed\\_test",
    ),
    "Command failed: npm run test\n**Failed Tests**\nfailed_test",
  );
});

Deno.test("ship output converts supported terminal styles to Signal formatting", () => {
  assertEquals(
    cleanCommandOutput(
      "\u001b[1mbold \u001b[3mitalic\u001b[23m\u001b[9m strike\u001b[29m\u001b[22m\u001b[39m",
    ),
    "**bold *italic*~~ strike~~**",
  );
});
