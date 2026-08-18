import {
  commandEnabled,
  helpMessage,
  parseStartupOptions,
  shutdownAnnouncement,
  startupAnnouncement,
} from "../src/startup.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
}

Deno.test("startup modes default to all supported capabilities", () => {
  const options = parseStartupOptions([]);
  assertEquals(options.modes, ["ask", "feature", "dispatch"]);
  assertEquals(options.restricted, false);
  assertEquals(commandEnabled({ kind: "codex", instruction: "fix" }, options), true);
});

Deno.test("startup modes can be selected and combined", () => {
  const options = parseStartupOptions(["--mode", "feature,ask"]);
  assertEquals(options.modes, ["ask", "feature"]);
  assertEquals(options.restricted, true);
  assertEquals(commandEnabled({ kind: "ask", question: "why?" }, options), true);
  assertEquals(commandEnabled({ kind: "dispatch", args: [] }, options), false);
  assertEquals(commandEnabled({ kind: "status" }, options), false);
});

Deno.test("startup announcement names enabled capabilities", () => {
  const options = parseStartupOptions(["--mode", "ask,feature"]);
  const message = startupAnnouncement(options);
  if (!message.includes("🗼✨") || !message.includes("/ask") || !message.includes("/feature")) {
    throw new Error(`Unexpected startup announcement: ${message}`);
  }
  if (message.includes("/dispatch") || message.includes("/codex")) {
    throw new Error(`Disabled command was announced: ${message}`);
  }
  assertEquals(helpMessage(options).includes("/status"), false);
});

Deno.test("unrestricted startup announces and helps with every command", () => {
  const options = parseStartupOptions([]);
  const announcement = startupAnnouncement(options);
  const help = helpMessage(options);
  for (const command of ["/codex", "/ask", "/feature", "/dispatch", "/status", "/help"]) {
    if (!announcement.includes(command) && command !== "/help") {
      throw new Error(`Startup omitted ${command}`);
    }
    if (!help.includes(command)) throw new Error(`Help omitted ${command}`);
  }
});

Deno.test("shutdown announcement explains why the tower is going offline", () => {
  const message = shutdownAnnouncement("SIGTERM");
  if (!message.includes("🗼🌙") || !message.includes("termination request")) {
    throw new Error(`Unexpected shutdown announcement: ${message}`);
  }
});
