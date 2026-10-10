#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command = "help", ...args] = process.argv.slice(2);

function executable(name) {
  const candidates = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((entry) => join(entry, name)),
    join(homedir(), ".deno", "bin", name),
    join(homedir(), ".local", "bin", name),
    join(homedir(), ".codex", "bin", name),
  ];
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

if (["help", "--help", "-h"].includes(command)) {
  process.stdout.write([
    "Signal Control Tower",
    "",
    "Usage:",
    "  signal-control-tower setup   Provision and configure this laptop interactively",
    "  signal-control-tower doctor  Validate an existing configuration",
    "  signal-control-tower run     Start the local Signal runner",
    "  signal-control-tower send    Queue a message or document for the configured group",
    "",
  ].join("\n"));
  process.exit(0);
}

let child;
if (command === "setup") {
  child = spawnSync(process.execPath, [resolve(packageRoot, "src/setup.mjs"), ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
} else if (command === "doctor" || command === "run" || command === "send") {
  const deno = executable("deno");
  if (!deno) {
    process.stderr.write("Deno is missing. Run: signal-control-tower setup\n");
    process.exit(1);
  }
  const permissions = [
    "--allow-read",
    "--allow-write",
    "--allow-run",
    "--allow-env",
    "--allow-net=127.0.0.1:8765",
  ];
  const entrypoint = command === "send" ? "src/send.ts" : "src/main.ts";
  const modeArgs = command === "doctor" ? ["--doctor", ...args] : args;
  child = spawnSync(
    deno,
    [
      "run",
      "--node-modules-dir=none",
      ...permissions,
      resolve(packageRoot, entrypoint),
      ...modeArgs,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    },
  );
} else {
  process.stderr.write(`Unknown command: ${command}\nRun signal-control-tower help for usage.\n`);
  process.exit(2);
}

if (child.error) {
  process.stderr.write(`${child.error.message}\n`);
  process.exit(1);
}
process.exit(child.status ?? 1);
