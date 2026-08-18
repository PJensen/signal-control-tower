import { basename } from "node:path";

import { loadConfig } from "./config.ts";
import { queueSignalDelivery } from "./signal-delivery.ts";

interface SendOptions {
  configPath: string;
  file?: string;
  message?: string;
  title?: string;
}

function options(args: string[]): SendOptions {
  const parsed: SendOptions = { configPath: "signal-control-tower.json" };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["--config", "--file", "--message", "--title"].includes(argument ?? "")) {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--config") parsed.configPath = value;
      else if (argument === "--file") parsed.file = value;
      else if (argument === "--message") parsed.message = value;
      else parsed.title = value;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "Usage: signal-control-tower send [--file PATH] [--message TEXT] [--title TEXT] [--config PATH]\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (!parsed.file && !parsed.message) {
    throw new Error("Specify --file, --message, or both.");
  }
  return parsed;
}

const selected = options(process.argv.slice(2));
const config = await loadConfig(selected.configPath);
const body = selected.message ?? `Attached file: ${basename(selected.file ?? "file")}`;
const queued = await queueSignalDelivery(
  config.stateDirectory,
  body,
  selected.title,
  selected.file,
);
process.stdout.write(`Queued Signal delivery ${queued.id}\n`);
