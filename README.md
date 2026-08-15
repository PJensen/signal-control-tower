# Signal Control Tower

Signal Control Tower is a small daemon that turns commands from an allow-listed Signal group into
isolated Codex work items. It tracks work locally and supports status, cancellation, publication,
deployment, feature capture, and activity summaries.

## Interactive laptop setup

From this repository's root, use Node 22 and run the local NPX package:

```bash
nvm use
npx --yes --package=. signal-control-tower setup
```

The setup checks or installs Deno, `signal-cli`, `qrencode`, and Codex; links Signal with a terminal
QR plus an ignored `.signal-control-tower/signal-link.png`; discovers the Signal account and
defaults to the `MFIQ.ai` group; verifies the MFIQ checkout; authenticates Codex; creates an
owner-only `signal-control-tower.json`; and runs the end-to-end doctor. It prompts before `sudo`,
login, config replacement, Git-hook changes, or enabling `/publish` and `/deploy`.

Nothing is deployed. The long-lived runner executes on this laptop using its local Signal, Codex,
Git, and project credentials.

After setup:

```bash
npx --yes --package=. signal-control-tower doctor
npx --yes --package=. signal-control-tower run
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
by default; questions are always executed in a read-only sandbox.

## Development and release

Run `deno task validate` before merging or tagging. Keep user-visible changes in `CHANGELOG.md`,
update its Unreleased section, then create a version tag after CI passes.

The source lives in `src/`; focused tests live in `tests/`. No third-party runtime dependencies are
required.
