# Signal Control Tower

Signal Control Tower is a small daemon that turns commands from an allow-listed Signal group into
Codex work items in one mounted workspace. It tracks work locally and supports status, cancellation,
shipping, feature capture, durable SME context capture, and Entire dispatch summaries.

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
login, config replacement, or Git-hook changes.

Nothing is deployed. The long-lived runner executes on this laptop using its local Signal, Codex,
Git, and workspace credentials.

After setup:

```bash
npx --yes github:PJensen/signal-control-tower doctor
npx --yes github:PJensen/signal-control-tower run
```

The running tower also exposes a loopback MCP endpoint at `http://127.0.0.1:8765/mcp`. Configure
Codex sessions to use that shared endpoint for `signal_send_message`, `signal_send_file`, and
`signal_outbox_status`; messages are queued through the same durable outbox as the CLI.

Local tools can queue a message or Markdown document for the configured Signal group through the
runner's durable outbox:

```bash
npx --yes github:PJensen/signal-control-tower send --file report.md --title "Underwriting architecture"
```

The command does not open another Signal connection. `--file` sends a real attachment; `--message`
sends text, and the two may be combined to add a caption. The running tower retains the delivery for
retry if sending fails and splits long text-only deliveries into ordered, Signal-safe blocks.

## Manual setup

1. Copy `signal-control-tower.example.json` to `signal-control-tower.json`.
2. Replace the Signal account, group, sender, and workspace values.
3. Validate the repository with `deno task validate`.
4. Check external tools and configuration with
   `deno task doctor -- --config signal-control-tower.json`.
5. Start the daemon with `deno task start -- --config signal-control-tower.json`.

Use `--mode ask`, `--mode feature`, or `--mode dispatch` to restrict the runner to those commands.
Combine modes with commas (for example, `--mode ask,feature`). Omitting `--mode` enables the full
protocol. After the Signal group is verified, the tower announces that it is online and lists the
enabled commands in the channel; `/help` shows the same command set.

The runtime config and `.signal-control-tower/` state are intentionally ignored by Git because they
can contain local paths and operational metadata.

The runner writes an owner-only JSONL audit trail to `.signal-control-tower/logs/events.jsonl`. It
records allow-listed Signal input from the configured group, parsed commands, subprocess output,
work events, errors, and exact outbound messages. Available inbound and outbound attachment files
are copied into `.signal-control-tower/logs/attachments/` with their size and SHA-256 hash in the
event log. On `SIGINT` or `SIGTERM`, the runner records the shutdown, announces it in the Signal
channel, and then closes the outbox and Signal connection.

Manual requirements are Deno 2.x, a linked `signal-cli`, an authenticated Codex CLI, the configured
Git checkout, and optionally Entire for `/dispatch`.

## Signal commands

| Command                  | Purpose                                                                       |
| ------------------------ | ----------------------------------------------------------------------------- |
| `/codex`                 | Run a build or fix task. A multiline message may contain the instruction.     |
| `/ask`                   | Ask a read-only code question.                                                |
| `/status [id]`           | Show the latest or selected work item.                                        |
| `/cancel [id]`           | Cancel queued or running work.                                                |
| `/ship`                  | Refresh main, test, migrate, and deploy the workspace.                        |
| `/feature <idea>`        | Record a feature request.                                                     |
| `/capture start [title]` | Start recording the sender's ordinary messages as workspace context.          |
| `/capture status`        | Show the sender's active capture and message count.                           |
| `/capture done`          | Finish the capture and write a verbatim Markdown transcript to the workspace. |
| `/capture cancel`        | Stop capturing; the ordinary audit trail remains intact.                      |
| `/dispatch [flags]`      | Generate a recent agent-work summary through `entire dispatch`.               |
| `/context`               | Show the mounted workspace configuration.                                     |
| `/help`                  | Show the command card.                                                        |

Only configured senders in the configured group are accepted. Write tasks use the mounted workspace
and commit/push successful changes; questions are always executed in a read-only sandbox. Every
write task must pass the workspace's `validateCommand` before it is marked complete. `/ship` runs
the configured workspace `shipCommands` in order and deploys the refreshed remote `main` after
retaining any local stash.

Codex can return requested workspace files to Signal by putting `ATTACHMENT: relative/path` on its
own line in the final response. This also works for `/ask`, but `/ask` may only return an existing
file because it remains read-only. At most five regular files of 25 MB each are accepted, and paths
or symlinks that escape the task workspace are rejected.

Long Codex answers and Entire dispatches are retained in full and delivered as ordered, Signal-safe
message blocks rather than truncated.

Context capture is scoped to one sender in the configured group. While a session is active, that
sender's ordinary messages and available attachments are retained in restart-safe owner-only state;
all other commands are rejected until the capture is completed or cancelled. `/capture done` writes
the source transcript and copied attachments under `docs/context/inbox/` in the workspace. Commands
are not included in the transcript. The transcript is evidence, not an AI-authored decision record;
teams can curate its facts into their durable product documentation without losing the original
wording and provenance.

## Development and release

Run `deno task validate` before merging or tagging. Keep user-visible changes in `CHANGELOG.md`,
update its Unreleased section, then create a version tag after CI passes.

The source lives in `src/`; focused tests live in `tests/`. No third-party runtime dependencies are
required.
