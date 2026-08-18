import { queueSignalDelivery } from "../src/signal-delivery.ts";
import { formatOutboxEvent, outboxDelivery } from "../src/outbox.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

Deno.test("signal deliveries are durably queued and formatted", async () => {
  const stateDirectory = await Deno.makeTempDir({ prefix: "signal-delivery-" });
  try {
    const queued = await queueSignalDelivery(stateDirectory, "  Architecture body\n", "MFIQ");
    const event = JSON.parse(await Deno.readTextFile(queued.path));
    assertEquals(event.kind, "signal-delivery");
    assertEquals(event.body, "Architecture body");
    assertEquals(formatOutboxEvent(event), "MFIQ\n\nArchitecture body");
  } finally {
    await Deno.remove(stateDirectory, { recursive: true });
  }
});

Deno.test("file deliveries spool a real Signal attachment", async () => {
  const stateDirectory = await Deno.makeTempDir({ prefix: "signal-file-delivery-" });
  try {
    const source = `${stateDirectory}/architecture.md`;
    await Deno.writeTextFile(source, "Architecture\n");
    const queued = await queueSignalDelivery(
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
