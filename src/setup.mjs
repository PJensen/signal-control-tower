import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseSignalAccounts(output) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("signal-cli listAccounts did not return an array");
  return parsed.flatMap((entry) => {
    if (typeof entry === "string" && entry.length > 0) return [{ account: entry }];
    if (typeof entry !== "object" || entry === null) return [];
    const account = typeof entry.number === "string"
      ? entry.number
      : typeof entry.account === "string"
      ? entry.account
      : undefined;
    return account
      ? [{ account, ...(typeof entry.name === "string" ? { name: entry.name } : {}) }]
      : [];
  });
}

export function parseSignalGroups(output) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("signal-cli listGroups did not return an array");
  return parsed.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    if (typeof entry.id !== "string" || typeof entry.name !== "string") return [];
    return [{
      id: entry.id,
      name: entry.name,
      isMember: entry.isMember !== false,
      isBlocked: entry.isBlocked === true,
    }];
  });
}

export function createSetupConfig(input) {
  return {
    signal: {
      account: input.account,
      groupId: input.group.id,
      groupName: input.group.name,
      allowedSenders: [input.allowedSender],
      executable: input.signalExecutable,
    },
    codex: { executable: input.codexExecutable, extraArgs: [] },
    activity: { executable: input.activityExecutable },
    stateDirectory: ".signal-control-tower",
    projects: {
      mfiq: {
        path: input.projectPath,
        allowWrite: true,
        baseRef: "HEAD",
        isolatedWorktree: true,
        ...(input.enableRelease
          ? {
            release: {
              publishRemote: "origin",
              validateCommand: ["npm", "run", "validate"],
              deployCommand: ["npm", "run", "deploy"],
            },
          }
          : {}),
      },
    },
  };
}

async function isExecutable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(name) {
  if (name.includes("/") || isAbsolute(name)) {
    const path = resolve(name);
    return await isExecutable(path) ? path : undefined;
  }
  const candidates = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((entry) => join(entry, name)),
    join(homedir(), ".deno", "bin", name),
    join(homedir(), ".local", "bin", name),
    join(homedir(), ".codex", "bin", name),
    join("/usr/local/bin", name),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function confirm(terminal, question, defaultYes) {
  const marker = defaultYes ? "Y/n" : "y/N";
  const answer = (await terminal.question(`${question} [${marker}] `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

async function input(terminal, question, fallback) {
  const answer = (await terminal.question(`${question} [${fallback}] `)).trim();
  return answer || fallback;
}

async function choose(terminal, question, values, label, preferred = 0) {
  if (values.length === 0) throw new Error(`No choices available for ${question}`);
  if (values.length === 1) return values[0];
  process.stdout.write(`${question}\n`);
  values.forEach((value, index) => {
    process.stdout.write(
      `  ${index + 1}. ${label(value)}${index === preferred ? " (default)" : ""}\n`,
    );
  });
  while (true) {
    const answer = (await terminal.question(`Choose 1-${values.length} [${preferred + 1}] `))
      .trim();
    const index = answer ? Number.parseInt(answer, 10) - 1 : preferred;
    if (values[index] !== undefined) return values[index];
    process.stdout.write("Please enter one of the listed numbers.\n");
  }
}

function runCapture(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 4_000_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function runInteractive(terminal, command, args, cwd = process.cwd()) {
  terminal.pause();
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
  terminal.resume();
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${String(result.status)}`);
}

async function runInstaller(terminal, url, label) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} installer download failed with HTTP ${response.status}`);
  }
  const installer = join(tmpdir(), `${label.toLowerCase()}-install-${process.pid}.sh`);
  await writeFile(installer, await response.text(), { mode: 0o700 });
  try {
    runInteractive(terminal, "/bin/sh", [installer]);
  } finally {
    await unlink(installer).catch(() => undefined);
  }
}

async function installSignalCli(terminal) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      "Automatic signal-cli installation supports x64 Linux only; install it manually and rerun setup.",
    );
  }
  const latest = await fetch("https://github.com/AsamK/signal-cli/releases/latest", {
    redirect: "follow",
  });
  if (!latest.ok) throw new Error(`signal-cli release lookup failed with HTTP ${latest.status}`);
  const version = latest.url.match(/\/tag\/v?([^/]+)$/u)?.[1];
  if (!version) throw new Error(`Could not determine signal-cli version from ${latest.url}`);
  const archive = join(tmpdir(), `signal-cli-${version}-${process.pid}.tar.gz`);
  const download = await fetch(
    `https://github.com/AsamK/signal-cli/releases/download/v${version}/signal-cli-${version}-Linux-native.tar.gz`,
  );
  if (!download.ok) throw new Error(`signal-cli download failed with HTTP ${download.status}`);
  await writeFile(archive, new Uint8Array(await download.arrayBuffer()), { mode: 0o600 });
  try {
    runInteractive(terminal, "sudo", ["tar", "-xzf", archive, "-C", "/opt"]);
    runInteractive(terminal, "sudo", ["ln", "-sf", "/opt/signal-cli", "/usr/local/bin/signal-cli"]);
  } finally {
    await unlink(archive).catch(() => undefined);
  }
}

async function ensureQrencode(terminal) {
  const existing = await findExecutable("qrencode");
  if (existing) return existing;
  if (process.platform !== "linux") return undefined;
  if (!await confirm(terminal, "Install qrencode for a terminal QR and local PNG?", true)) {
    return undefined;
  }
  runInteractive(terminal, "sudo", ["apt-get", "install", "-y", "qrencode"]);
  return findExecutable("qrencode");
}

async function linkSignal(terminal, signalExecutable, qrencode, stateDirectory) {
  process.stdout.write("\nOn your phone: Signal → Settings → Linked devices → Link new device.\n");
  terminal.pause();
  const child = spawn(signalExecutable, ["link", "-n", "Signal Control Tower"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  let combined = "";
  let rendered = false;
  const inspect = async (chunk) => {
    const text = new TextDecoder().decode(chunk);
    process.stdout.write(text);
    combined = `${combined}${text}`.slice(-20_000);
    const uri = combined.match(/sgnl:\/\/linkdevice\?[^\s"']+/u)?.[0];
    if (!uri || rendered || !qrencode) return;
    rendered = true;
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const png = join(stateDirectory, "signal-link.png");
    const pngResult = spawnSync(qrencode, ["-s", "12", "-o", png, uri], { stdio: "inherit" });
    if (pngResult.status === 0) process.stdout.write(`\nQR image saved to ${png}\n`);
    process.stdout.write("\nScan this terminal QR (no image viewer is launched):\n\n");
    spawnSync(qrencode, ["-t", "ANSIUTF8", "-m", "2", uri], { stdio: "inherit" });
  };
  child.stdout.on("data", (chunk) => void inspect(chunk));
  child.stderr.on("data", (chunk) => void inspect(chunk));
  const status = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
  terminal.resume();
  if (status !== 0) throw new Error(`signal-cli link exited with code ${status}`);
}

function listAccounts(signalExecutable) {
  return parseSignalAccounts(runCapture(signalExecutable, ["--output", "json", "listAccounts"]));
}

function listGroups(signalExecutable, account) {
  return parseSignalGroups(
    runCapture(signalExecutable, ["--account", account, "--output", "json", "listGroups"]),
  ).filter((group) => group.isMember && !group.isBlocked);
}

async function discoverGroups(terminal, signalExecutable, account) {
  let groups = listGroups(signalExecutable, account);
  if (groups.length > 0) return groups;
  process.stdout.write("No groups are synchronized; requesting them from the primary device…\n");
  runCapture(signalExecutable, ["--account", account, "sendSyncRequest"]);
  runInteractive(terminal, signalExecutable, ["--account", account, "receive", "--timeout", "10"]);
  groups = listGroups(signalExecutable, account);
  return groups;
}

function runTower(terminal, denoExecutable, args) {
  runInteractive(terminal, denoExecutable, [
    "run",
    "--allow-read",
    "--allow-write",
    "--allow-run",
    "--allow-env",
    resolve(packageRoot, "src/main.ts"),
    ...args,
  ]);
}

export async function runSetup() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < 22) {
    throw new Error(`Node 22+ is required (found ${process.versions.node}). Run: nvm use 22`);
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("\nSignal Control Tower setup\n==========================\n");

    let denoExecutable = await findExecutable("deno");
    if (!denoExecutable) {
      if (!await confirm(terminal, "Deno is missing. Run the official installer?", true)) {
        throw new Error("Deno is required");
      }
      await runInstaller(terminal, "https://deno.land/install.sh", "Deno");
      denoExecutable = await findExecutable("deno");
      if (!denoExecutable) {
        throw new Error("Deno installed but is not visible; reopen the terminal and rerun setup.");
      }
    }
    process.stdout.write(`✓ Deno: ${denoExecutable}\n`);

    let signalExecutable = await findExecutable("signal-cli");
    if (!signalExecutable) {
      if (!await confirm(terminal, "signal-cli is missing. Install it under /opt?", true)) {
        throw new Error("signal-cli is required");
      }
      await installSignalCli(terminal);
      signalExecutable = await findExecutable("signal-cli");
      if (!signalExecutable) throw new Error("signal-cli was installed but is not executable");
    }
    process.stdout.write(`✓ signal-cli: ${signalExecutable}\n`);

    let accounts = listAccounts(signalExecutable);
    if (accounts.length === 0) {
      await linkSignal(
        terminal,
        signalExecutable,
        await ensureQrencode(terminal),
        resolve(".signal-control-tower"),
      );
      accounts = listAccounts(signalExecutable);
    }
    if (accounts.length === 0) throw new Error("No linked Signal account was found");
    const account = await choose(
      terminal,
      "Choose the Signal account:",
      accounts,
      (value) => value.name ? `${value.account} — ${value.name}` : value.account,
    );
    process.stdout.write(`✓ Signal account: ${account.account}\n`);

    const groups = await discoverGroups(terminal, signalExecutable, account.account);
    if (groups.length === 0) throw new Error("No Signal groups are available");
    const preferred = Math.max(0, groups.findIndex((group) => group.name === "MFIQ.ai"));
    const group = await choose(
      terminal,
      "Choose the intake group:",
      groups,
      (value) => value.name,
      preferred,
    );
    process.stdout.write(`✓ Signal group: ${group.name}\n`);

    let codexExecutable = await findExecutable("codex");
    if (!codexExecutable) {
      if (!await confirm(terminal, "Codex is missing. Run OpenAI's official installer?", true)) {
        throw new Error("Codex is required");
      }
      await runInstaller(terminal, "https://chatgpt.com/codex/install.sh", "Codex");
      codexExecutable = await findExecutable("codex");
      if (!codexExecutable) {
        throw new Error("Codex installed but is not visible; reopen the terminal and rerun setup.");
      }
    }
    process.stdout.write(`✓ Codex: ${codexExecutable}\n`);
    if (spawnSync(codexExecutable, ["login", "status"], { env: process.env }).status !== 0) {
      if (!await confirm(terminal, "Codex is not authenticated. Start device-code login?", true)) {
        throw new Error("Codex authentication is required");
      }
      runInteractive(terminal, codexExecutable, ["login", "--device-auth"]);
      runCapture(codexExecutable, ["login", "status"]);
    }
    process.stdout.write("✓ Codex authentication is active\n");

    const defaultProjectPath = resolve(process.cwd(), "../mfiq.ai");
    const projectPath = resolve(await input(terminal, "MFIQ checkout path", defaultProjectPath));
    runCapture("git", ["-C", projectPath, "rev-parse", "--show-toplevel"]);
    process.stdout.write(`✓ MFIQ checkout: ${projectPath}\n`);

    const configPath = resolve("signal-control-tower.json");
    let writeConfig = true;
    try {
      await readFile(configPath, "utf8");
      writeConfig = await confirm(terminal, "signal-control-tower.json exists. Replace it?", false);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (writeConfig) {
      const allowedSender = await input(
        terminal,
        "Allowed Signal sender (number or ACI)",
        account.account,
      );
      const enableRelease = await confirm(terminal, "Enable /publish and /deploy for MFIQ?", false);
      const config = createSetupConfig({
        account: account.account,
        allowedSender,
        group,
        signalExecutable,
        codexExecutable,
        activityExecutable: await findExecutable("entire") ?? "entire",
        projectPath,
        enableRelease,
      });
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await chmod(configPath, 0o600);
      process.stdout.write(`✓ Wrote ${configPath}\n`);
    } else {
      process.stdout.write(`✓ Keeping ${configPath}\n`);
    }

    try {
      await access(resolve(projectPath, ".githooks"));
      if (await confirm(terminal, "Enable MFIQ's repository-managed Git hooks?", true)) {
        runCapture("git", ["-C", projectPath, "config", "core.hooksPath", ".githooks"]);
        process.stdout.write("✓ Git hooks enabled\n");
      }
    } catch {
      // Hooks are optional.
    }

    process.stdout.write("\nRunning the end-to-end doctor…\n");
    runTower(terminal, denoExecutable, ["--doctor"]);
    process.stdout.write("\n✓ Setup complete.\n");
    if (await confirm(terminal, "Start Signal Control Tower now?", false)) {
      terminal.close();
      runTower(terminal, denoExecutable, []);
      return;
    }
    process.stdout.write("Start later with: npx --yes --package=. signal-control-tower run\n");
  } finally {
    terminal.close();
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runSetup().catch((error) => {
    process.stderr.write(`\nSetup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
