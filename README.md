# Signal Control Tower

Signal Control Tower is a small daemon that turns commands from an allow-listed Signal group into
isolated Codex work items. It tracks work locally and supports status, cancellation, publication,
deployment, feature capture, and activity summaries.

## Requirements

- [Deno](https://deno.com/) 2.x
- `signal-cli`, registered for the configured Signal account
- Codex CLI
- Git checkouts for every configured project
- Entire CLI when `/activity` is enabled

## Set up

1. Copy `signal-control-tower.example.json` to `signal-control-tower.json`.
2. Replace the Signal account, group, sender, and project values.
3. Validate the repository with `deno task validate`.
4. Check external tools and configuration with
   `deno task doctor -- --config signal-control-tower.json`.
5. Start the daemon with `deno task start -- --config signal-control-tower.json`.

The runtime config and `.signal-control-tower/` state are intentionally ignored by Git because they
can contain local paths and operational metadata.

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
