import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  IntakeConfig,
  ProjectConfig,
  WorkItemDeployment,
  WorkItemPublication,
  WorkItemRecord,
} from "./types.ts";

const execFileAsync = promisify(execFile);

async function execute(
  executable: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(executable, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 2_000_000,
    timeout: 30 * 60_000,
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function git(workspace: string, args: string[]): Promise<string> {
  return (await execute("git", args, workspace)).stdout;
}

export class WorkItemReleaseManager {
  readonly #config: IntakeConfig;
  #active = false;

  constructor(config: IntakeConfig) {
    this.#config = config;
  }

  async publish(record: WorkItemRecord): Promise<WorkItemPublication> {
    return this.#exclusive(async () => {
      const { workspace, project } = await this.#releaseTarget(record);
      const [validateExecutable, ...validateArgs] = project.release.validateCommand;
      if (!validateExecutable) throw new Error("The configured validation command is empty.");
      await execute(validateExecutable, validateArgs, workspace, process.env);
      if (await git(workspace, ["status", "--porcelain"])) {
        await git(workspace, ["add", "--all"]);
        await git(workspace, ["commit", "-m", `Signal work item ${record.item.id}`]);
      }
      const [head, branch, status] = await Promise.all([
        git(workspace, ["rev-parse", "HEAD"]),
        git(workspace, ["branch", "--show-current"]),
        git(workspace, ["status", "--porcelain"]),
      ]);
      if (!branch) throw new Error("Publishing requires a checked-out branch, not detached HEAD.");
      if (status) throw new Error("The checkout is still dirty after the release commit.");
      const remote = project.release.publishRemote;
      await execute("git", ["push", remote, `HEAD:refs/heads/${branch}`], workspace);
      return {
        remote,
        branch,
        commit: head,
        publishedAt: new Date().toISOString(),
      };
    });
  }

  async deploy(
    record: WorkItemRecord,
  ): Promise<{ deployment: WorkItemDeployment; output: string }> {
    return this.#exclusive(async () => {
      const { workspace, project } = await this.#releaseTarget(record);
      const deployCommand = project.release.deployCommand;
      if (!deployCommand) throw new Error(`Deploy is disabled for project ${record.item.project}`);
      const [head, branch, status] = await Promise.all([
        git(workspace, ["rev-parse", "HEAD"]),
        git(workspace, ["branch", "--show-current"]),
        git(workspace, ["status", "--porcelain"]),
      ]);
      if (status) {
        throw new Error("The checkout has uncommitted changes; publish them before deploying.");
      }
      if (record.publication?.commit !== head || record.publication.branch !== branch) {
        throw new Error("Publish this exact work-item commit before deploying it.");
      }
      const [executable, ...args] = deployCommand;
      if (!executable) throw new Error("The configured deploy command is empty.");
      const result = await execute(executable, args, workspace, {
        ...process.env,
        WORKERS_CI_COMMIT_SHA: head,
      });
      return {
        deployment: { commit: head, deployedAt: new Date().toISOString() },
        output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
      };
    });
  }

  async #releaseTarget(
    record: WorkItemRecord,
  ): Promise<
    {
      workspace: string;
      project: ProjectConfig & { release: NonNullable<ProjectConfig["release"]> };
    }
  > {
    if (record.status !== "completed" || record.item.mode === "question") {
      throw new Error("Only a completed write task can be published or deployed.");
    }
    const project = this.#config.projects[record.item.project];
    if (!project) throw new Error(`Project ${record.item.project} is no longer configured.`);
    if (!project.release) {
      throw new Error(`Publishing is disabled for project ${record.item.project}.`);
    }

    const workspace = project.isolatedWorktree && record.item.branch
      ? join(this.#config.stateDirectory, "worktrees", record.item.id)
      : project.path;
    const [actualWorkspace, topLevel] = await Promise.all([
      realpath(workspace),
      git(workspace, ["rev-parse", "--show-toplevel"]).then(realpath),
    ]);
    if (actualWorkspace !== topLevel) {
      throw new Error("The retained worktree path failed validation.");
    }
    if (project.isolatedWorktree && record.item.branch) {
      const branch = await git(workspace, ["branch", "--show-current"]);
      if (branch !== record.item.branch) {
        throw new Error("The retained worktree is on an unexpected branch.");
      }
    }
    return { workspace, project: { ...project, release: project.release } };
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active) throw new Error("Another publish or deploy operation is already running.");
    this.#active = true;
    try {
      return await operation();
    } finally {
      this.#active = false;
    }
  }
}
