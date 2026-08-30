import type { IntakeCommand } from "./types.ts";

export const STARTUP_MODES = ["ask", "feature", "dispatch"] as const;
export type StartupMode = (typeof STARTUP_MODES)[number];

export interface StartupOptions {
  configPath: string;
  doctor: boolean;
  modes: StartupMode[];
  restricted: boolean;
}

const COMMANDS: Array<{ kind: IntakeCommand["kind"]; line: string; mode?: StartupMode }> = [
  { kind: "codex", line: "🤖 /codex <task> — build or fix" },
  { kind: "ask", line: "🔎 /ask <question> — inspect code", mode: "ask" },
  { kind: "feature", line: "💡 /feature <idea> — save a request", mode: "feature" },
  { kind: "capture", line: "🎙️ /capture start [title] — record context" },
  {
    kind: "dispatch",
    line: "📡 /dispatch [flags] — Entire summary of recent agent work",
    mode: "dispatch",
  },
  { kind: "status", line: "📍 /status [id] — check progress" },
  { kind: "cancel", line: "🛑 /cancel [id] — stop work" },
  { kind: "ship", line: "🚀 /ship — refresh main · test · migrate · deploy" },
  { kind: "context", line: "🧭 /context — show workspace setup" },
  { kind: "help", line: "✨ /help — show this card" },
];

export function parseStartupOptions(args: string[]): StartupOptions {
  let configPath = "signal-control-tower.json";
  let doctor = false;
  const selected = new Set<StartupMode>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--doctor") doctor = true;
    else if (arg === "--config") {
      const value = args[index + 1];
      if (!value) throw new Error("--config requires a path");
      configPath = value;
      index += 1;
    } else if (arg === "--mode") {
      const value = args[index + 1];
      if (!value) throw new Error("--mode requires ask, feature, or dispatch");
      for (const mode of value.split(",")) {
        if (!STARTUP_MODES.includes(mode as StartupMode)) {
          throw new Error(`Invalid startup mode: ${mode}. Use ask, feature, or dispatch.`);
        }
        selected.add(mode as StartupMode);
      }
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error("help");
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }

  return {
    configPath,
    doctor,
    modes: selected.size ? STARTUP_MODES.filter((mode) => selected.has(mode)) : [...STARTUP_MODES],
    restricted: selected.size > 0,
  };
}

function enabledCommands(options: StartupOptions): typeof COMMANDS {
  if (!options.restricted) return COMMANDS;
  return COMMANDS.filter((command) =>
    command.kind === "help" || (command.mode !== undefined && options.modes.includes(command.mode))
  );
}

export function commandEnabled(command: IntakeCommand, options: StartupOptions): boolean {
  if (!options.restricted || command.kind === "help") return true;
  const definition = COMMANDS.find((candidate) => candidate.kind === command.kind);
  return definition?.mode !== undefined && options.modes.includes(definition.mode);
}

export function helpMessage(options: StartupOptions): string {
  return ["🗼 Signal Control Tower", "", ...enabledCommands(options).map(({ line }) => line)].join(
    "\n",
  );
}

export function startupAnnouncement(options: StartupOptions): string {
  return [
    "🗼✨ Signal Control Tower is online! 📡",
    "",
    "Enabled commands:",
    ...enabledCommands(options).filter(({ kind }) => kind !== "help").map(({ line }) => line),
    "",
    "Send /help for commands. 🎛️",
  ].join("\n");
}

export function shutdownAnnouncement(signal: "SIGINT" | "SIGTERM"): string {
  const reason = signal === "SIGINT" ? "operator interrupt" : "termination request";
  return [
    "🗼🌙 Signal Control Tower is going offline. 📡",
    `Reason: ${reason}`,
    "Inbound commands are no longer being accepted. Until next watch. 👋",
  ].join("\n");
}
