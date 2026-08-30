import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { IntakeConfig, WorkspaceConfig } from "./types.ts";

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}
function optionalString(value: unknown, fallback: string, label: string): string {
  return value === undefined ? fallback : requiredString(value, label);
}
function boolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
}
function optionalStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
}
function commandArray(value: unknown, label: string): string[][] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array of commands`);
  }
  return value.map((command, index) => {
    if (!Array.isArray(command) || command.length === 0) {
      throw new Error(`${label}[${index}] must be a non-empty argument array`);
    }
    return command.map((argument, argumentIndex) =>
      requiredString(argument, `${label}[${index}][${argumentIndex}]`)
    );
  });
}
function resolveFrom(base: string, value: string): string {
  return isAbsolute(value) ? value : resolve(base, value);
}

function workspaceConfig(value: unknown, base: string): WorkspaceConfig {
  const workspace = object(value, "workspace");
  const validateCommand = workspace.validateCommand === undefined
    ? ["npm", "run", "test"]
    : optionalStringArray(workspace.validateCommand, "workspace.validateCommand");
  if (validateCommand.length === 0) throw new Error("workspace.validateCommand must not be empty");
  const shipCommands = workspace.shipCommands === undefined
    ? [["npm", "install"], ["npm", "run", "test"], ["npm", "run", "migrate:remote"], [
      "npm",
      "run",
      "deploy",
    ]]
    : commandArray(workspace.shipCommands, "workspace.shipCommands");
  return {
    path: resolveFrom(base, requiredString(workspace.path, "workspace.path")),
    allowWrite: boolean(workspace.allowWrite, true, "workspace.allowWrite"),
    validateCommand,
    shipCommands,
  };
}

export async function loadConfig(configPath: string): Promise<IntakeConfig> {
  const absolutePath = resolve(configPath);
  const base = dirname(absolutePath);
  const root = object(JSON.parse(await readFile(absolutePath, "utf8")) as unknown, "config");
  const signal = object(root.signal, "signal");
  const codex = object(root.codex ?? {}, "codex");
  const entire = object(root.entire ?? {}, "entire");
  const mcp = object(root.mcp ?? {}, "mcp");
  const portValue = mcp.port === undefined ? 8765 : mcp.port;
  if (
    typeof portValue !== "number" || !Number.isInteger(portValue) || portValue < 1 ||
    portValue > 65535
  ) {
    throw new Error("mcp.port must be an integer between 1 and 65535");
  }
  if (root.projects !== undefined) {
    throw new Error("projects is no longer supported; configure workspace");
  }
  const dataDirectory = signal.dataDirectory === undefined
    ? undefined
    : resolveFrom(base, requiredString(signal.dataDirectory, "signal.dataDirectory"));
  return {
    signal: {
      account: requiredString(signal.account, "signal.account"),
      groupId: requiredString(signal.groupId, "signal.groupId"),
      groupName: optionalString(signal.groupName, "Signal Control Tower", "signal.groupName"),
      allowedSenders: stringArray(signal.allowedSenders, "signal.allowedSenders"),
      executable: optionalString(signal.executable, "signal-cli", "signal.executable"),
      ...(dataDirectory ? { dataDirectory } : {}),
    },
    codex: {
      executable: optionalString(codex.executable, "codex", "codex.executable"),
      extraArgs: codex.extraArgs === undefined
        ? []
        : optionalStringArray(codex.extraArgs, "codex.extraArgs"),
      model: optionalString(codex.model, "gpt-5.6-terra", "codex.model"),
      reasoningEffort: optionalString(codex.reasoningEffort, "medium", "codex.reasoningEffort"),
    },
    entire: { executable: optionalString(entire.executable, "entire", "entire.executable") },
    stateDirectory: resolveFrom(
      base,
      optionalString(root.stateDirectory, ".signal-control-tower", "stateDirectory"),
    ),
    workspace: workspaceConfig(root.workspace, base),
    mcp: { host: optionalString(mcp.host, "127.0.0.1", "mcp.host"), port: portValue },
  };
}
