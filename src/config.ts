import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { IntakeConfig, ProjectConfig } from "./types.ts";

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

function resolveFrom(base: string, value: string): string {
  return isAbsolute(value) ? value : resolve(base, value);
}

function projectConfig(value: unknown, key: string, base: string): ProjectConfig {
  const project = object(value, `projects.${key}`);
  const release = project.release === undefined
    ? undefined
    : object(project.release, `projects.${key}.release`);
  const deployCommand = release?.deployCommand === undefined
    ? undefined
    : optionalStringArray(release.deployCommand, `projects.${key}.release.deployCommand`);
  if (deployCommand?.length === 0) {
    throw new Error(`projects.${key}.release.deployCommand must not be empty`);
  }
  const validateCommand = release?.validateCommand === undefined
    ? ["npm", "run", "validate"]
    : optionalStringArray(release.validateCommand, `projects.${key}.release.validateCommand`);
  if (validateCommand.length === 0) {
    throw new Error(`projects.${key}.release.validateCommand must not be empty`);
  }
  return {
    path: resolveFrom(base, requiredString(project.path, `projects.${key}.path`)),
    allowWrite: boolean(project.allowWrite, false, `projects.${key}.allowWrite`),
    baseRef: optionalString(project.baseRef, "HEAD", `projects.${key}.baseRef`),
    isolatedWorktree: boolean(
      project.isolatedWorktree,
      true,
      `projects.${key}.isolatedWorktree`,
    ),
    ...(release
      ? {
        release: {
          publishRemote: optionalString(
            release.publishRemote,
            "origin",
            `projects.${key}.release.publishRemote`,
          ),
          validateCommand,
          ...(deployCommand ? { deployCommand } : {}),
        },
      }
      : {}),
  };
}

export async function loadConfig(configPath: string): Promise<IntakeConfig> {
  const absolutePath = resolve(configPath);
  const base = dirname(absolutePath);
  const root = object(JSON.parse(await readFile(absolutePath, "utf8")) as unknown, "config");
  const signal = object(root.signal, "signal");
  const codex = object(root.codex ?? {}, "codex");
  const activity = object(root.activity ?? {}, "activity");
  const projectsInput = object(root.projects, "projects");
  const projects = Object.fromEntries(
    Object.entries(projectsInput).map(([key, value]) => {
      if (!/^[a-z0-9][a-z0-9_-]{0,47}$/u.test(key)) {
        throw new Error(`Invalid project key: ${key}`);
      }
      return [key, projectConfig(value, key, base)];
    }),
  );
  if (Object.keys(projects).length === 0) throw new Error("At least one project is required");

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
    },
    activity: {
      executable: optionalString(activity.executable, "entire", "activity.executable"),
    },
    stateDirectory: resolveFrom(
      base,
      optionalString(root.stateDirectory, ".signal-control-tower", "stateDirectory"),
    ),
    projects,
  };
}
