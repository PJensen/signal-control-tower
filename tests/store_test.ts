import { WorkItemStore } from "../src/store.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
}

function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) throw new Error(`Expected ${actual} to include ${expected}`);
}

function record(id: string, status: "queued" | "running" | "completed") {
  return {
    item: {
      id,
      instruction: "Test work item",
      attachments: [],
      source: {
        transport: "signal" as const,
        sender: "+15555550123",
        conversation: "group",
        messageId: id,
        timestamp: 1,
      },
      createdAt: "2026-08-17T00:00:00.000Z",
    },
    status,
    updatedAt: "2026-08-17T00:00:00.000Z",
  };
}

Deno.test("a new tower session interrupts active work without deleting history", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = new WorkItemStore(directory);
    await store.load();
    await store.put(record("queued", "queued"));
    await store.put(record("running", "running"));
    await store.put(record("completed", "completed"));

    const interrupted = await store.interruptActiveQueue();

    assertEquals(interrupted.map((entry) => entry.item.id).sort(), ["queued", "running"]);
    assertEquals(store.get("queued")?.status, "interrupted");
    assertStringIncludes(store.get("queued")?.error ?? "", "before this item began");
    assertEquals(store.get("running")?.status, "interrupted");
    assertStringIncludes(store.get("running")?.error ?? "", "while this item was running");
    assertEquals(store.get("completed")?.status, "completed");

    const reloaded = new WorkItemStore(directory);
    await reloaded.load();
    assertEquals(reloaded.all().length, 3);
    assertEquals(reloaded.get("queued")?.status, "interrupted");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
