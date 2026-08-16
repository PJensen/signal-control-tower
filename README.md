# Signal Control Tower

Signal Control Tower is a small daemon that turns commands from an allow-listed Signal group into
isolated Codex work items. It tracks work locally and supports status, cancellation, publication,
deployment, feature capture, and activity summaries.

## One-command laptop setup

With Node 22 active, run this from the directory where you want the tower's local configuration and
state to live:

```bash
nvm use
npx --yes github:PJensen/signal-control-tower setup
```

NPX fetches the package directly from GitHub; cloning or globally installing Signal Control Tower is
not required.

The setup checks or installs Deno, `signal-cli`, `qrencode`, and Codex; links Signal with a terminal
QR plus an ignored `.signal-control-tower/signal-link.png`; discovers the Signal account and
defaults to the `MFIQ.ai` group; verifies the MFIQ checkout; authenticates Codex; creates an
owner-only `signal-control-tower.json`; and runs the end-to-end doctor. It prompts before `sudo`,
login, config replacement, Git-hook changes, or enabling `/publish` and `/deploy`.

Nothing is deployed. The long-lived runner executes on this laptop using its local Signal, Codex,
Git, and project credentials.

After setup:

```bash
npx --yes github:PJensen/signal-control-tower doctor
npx --yes github:PJensen/signal-control-tower run
```

## Manual setup

1. Copy `signal-control-tower.example.json` to `signal-control-tower.json`.
2. Replace the Signal account, group, sender, and project values.
3. Validate the repository with `deno task validate`.
4. Check external tools and configuration with
   `deno task doctor -- --config signal-control-tower.json`.
5. Start the daemon with `deno task start -- --config signal-control-tower.json`.

The runtime config and `.signal-control-tower/` state are intentionally ignored by Git because they
can contain local paths and operational metadata.

Manual requirements are Deno 2.x, a linked `signal-cli`, an authenticated Codex CLI, the configured
Git checkout, and optionally Entire for `/activity`.

## Signal commands

| Command              | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `/codex [project]`   | Run a build or fix task. A multiline message may contain the instruction. |
| `/ask [project]`     | Ask a read-only code question.                                            |
| `/status [id]`       | Show the latest or selected work item.                                    |
| `/cancel [id]`       | Cancel queued or running work.                                            |
| `/publish <id>`      | Validate, commit, and push completed work.                                |
| `/deploy <id>`       | Run the configured production deployment.                                 |
| `/feature <idea>`    | Record a feature request.                                                 |
| `/activity [flags]`  | Generate a recent activity summary.                                       |
| `/context [project]` | Show available project configuration.                                     |
| `/help`              | Show the command card.                                                    |

Only configured senders in the configured group are accepted. Write tasks use isolated Git worktrees
by default; questions are always executed in a read-only sandbox. A successful write task
automatically validates, commits, pushes, and deploys when its project has release configuration;
manual `/publish` and `/deploy` commands remain available for retries.

Codex can return requested workspace files to Signal by putting `ATTACHMENT: relative/path` on its
own line in the final response. This also works for `/ask`, but `/ask` may only return an existing
file because it remains read-only. At most five regular files of 25 MB each are accepted, and paths
or symlinks that escape the task workspace are rejected.

Long Codex answers and activity dispatches are retained in full and delivered as ordered,
Signal-safe message blocks rather than truncated.

## Development and release

Run `deno task validate` before merging or tagging. Keep user-visible changes in `CHANGELOG.md`,
update its Unreleased section, then create a version tag after CI passes.

The source lives in `src/`; focused tests live in `tests/`. No third-party runtime dependencies are
required.
