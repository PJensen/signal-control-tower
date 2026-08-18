import { ContextCaptureStore } from "../src/context-capture.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("context capture survives restart and exports a verbatim transcript", async () => {
  const root = await Deno.makeTempDir({ prefix: "context-capture-" });
  const project = `${root}/project`;
  const state = `${root}/state`;
  try {
    await Deno.mkdir(project);
    const attachmentPath = `${root}/rent-roll.png`;
    await Deno.writeTextFile(attachmentPath, "image bytes");

    const first = new ContextCaptureStore(state);
    await first.load();
    const started = await first.start("cj", "group", "mfiq", "Rent roll workflow");
    await first.append({
      sender: "cj",
      groupId: "group",
      timestamp: 1_700_000_000_000,
      message: "The rent roll is optional.",
      attachments: [{ id: "image", filename: "rent-roll.png", path: attachmentPath }],
    });

    const restarted = new ContextCaptureStore(state);
    await restarted.load();
    assert(restarted.activeFor("cj", "group")?.id === started.id, "Capture was not restored");
    const completed = await restarted.complete("cj", "group", project);
    assert(completed?.messageCount === 1, "Unexpected message count");
    assert(completed.attachmentCount === 1, "Unexpected attachment count");

    const transcript = await Deno.readTextFile(`${project}/${completed.relativePath}`);
    assert(transcript.includes("The rent roll is optional."), "Transcript lost source text");
    assert(transcript.includes("assets/"), "Transcript did not link the attachment");
    assert(!restarted.activeFor("cj", "group"), "Completed capture remained active");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("context capture ignores duplicate Signal deliveries", async () => {
  const root = await Deno.makeTempDir({ prefix: "context-capture-" });
  try {
    const store = new ContextCaptureStore(root);
    await store.load();
    await store.start("cj", "group", "mfiq");
    const message = {
      sender: "cj",
      groupId: "group",
      timestamp: 1_700_000_000_000,
      message: "One fact",
      attachments: [],
    };
    await store.append(message);
    const capture = await store.append(message);
    assert(capture?.messages.length === 1, "Duplicate message was captured");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
