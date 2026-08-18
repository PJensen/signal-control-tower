import { EventLog } from "../src/event-log.ts";

Deno.test("event log retains JSONL events and attachment content", async () => {
  const root = await Deno.makeTempDir({ prefix: "signal-events-" });
  try {
    const attachment = `${root}/report.md`;
    await Deno.writeTextFile(attachment, "report body\n");
    const log = new EventLog(root);
    await log.record("signal.outbound", { message: "hello" }, [attachment]);

    const line = await Deno.readTextFile(`${root}/logs/events.jsonl`);
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.kind !== "signal.outbound") throw new Error("Missing event kind");
    const archived = (event.attachments as Array<Record<string, unknown>>)[0];
    if (!archived?.archivePath || archived.sha256 === undefined) {
      throw new Error("Missing attachment archive metadata");
    }
    const content = await Deno.readTextFile(String(archived.archivePath));
    if (content !== "report body\n") throw new Error("Attachment content was not retained");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
