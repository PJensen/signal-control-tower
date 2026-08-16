import { queueSignalDispatch } from "../src/dispatch.ts";
import { formatOutboxEvent, outboxDelivery } from "../src/outbox.ts";

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

Deno.test("file dispatches spool a real Signal attachment", async () => {
  const stateDirectory = await Deno.makeTempDir({ prefix: "signal-file-dispatch-" });
  try {
    const source = `${stateDirectory}/architecture.md`;
    await Deno.writeTextFile(source, "Architecture\n");
    const queued = await queueSignalDispatch(
      stateDirectory,
      "Attached file: architecture.md",
      "MFIQ",
      source,
    );
    const event = JSON.parse(await Deno.readTextFile(queued.path));
    const delivery = outboxDelivery(event);
    assertEquals(delivery.message, "MFIQ\n\nAttached file: architecture.md");
    assertEquals(delivery.attachments.length, 1);
    assertEquals(await Deno.readTextFile(delivery.attachments[0]), "Architecture\n");
  } finally {
    await Deno.remove(stateDirectory, { recursive: true });
  }
});
