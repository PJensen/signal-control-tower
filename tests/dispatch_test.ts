import { queueSignalDispatch } from "../src/dispatch.ts";
import { formatOutboxEvent } from "../src/outbox.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

Deno.test("signal dispatches are durably queued and formatted", async () => {
  const stateDirectory = await Deno.makeTempDir({ prefix: "signal-dispatch-" });
  try {
    const queued = await queueSignalDispatch(stateDirectory, "  Architecture body\n", "MFIQ");
    const event = JSON.parse(await Deno.readTextFile(queued.path));
    assertEquals(event.kind, "signal-dispatch");
    assertEquals(event.body, "Architecture body");
    assertEquals(formatOutboxEvent(event), "MFIQ\n\nArchitecture body");
  } finally {
    await Deno.remove(stateDirectory, { recursive: true });
  }
});
