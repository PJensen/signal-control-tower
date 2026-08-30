# Signal Control Tower

Signal Control Tower is a local daemon that turns commands from an allow-listed Signal group into
Codex work items for one configured Git workspace. Requests arrive through Signal, execution stays
on the operator's laptop, and work status, results, artifacts, and outbound messages are persisted
locally. It is not a hosted service and does not deploy anything by itself.

## What it provides

- Signal group and sender allow-listing.
- Durable, serialized Codex work items with queued, running, completed, failed, cancelled, and
  interrupted states.
- Read-only code questions through /ask, and write-capable tasks through /codex.
- Mandatory workspace validation after successful write tasks.
- Full, ordered delivery of long Codex and Entire responses.
- Feature capture, Entire dispatch summaries, SME context capture, and workspace artifact delivery.
- A loopback MCP endpoint that uses the same durable outbound queue as the CLI.

## Requirements

The packaged setup flow requires Node.js 22 or newer. The runner requires Deno 2.x, signal-cli,
an authenticated Codex CLI, Git, and the configured workspace's toolchain. entire is required for
/dispatch and the startup doctor. The project has no third-party runtime dependencies.

Automatic signal-cli installation supports x64 Linux. On other platforms, install the required
tools manually and use the manual configuration flow.

## Quick start

Run setup from the directory where the tower's configuration and local state should live:

~~~bash
nvm use 22
npx --yes github:PJensen/signal-control-tower setup
~~~

Setup checks or installs Deno, signal-cli, qrencode, and Codex; links Signal with a terminal QR;
discovers the Signal account and groups; authenticates Codex; verifies the Git checkout; writes an
owner-only signal-control-tower.json; and runs the end-to-end doctor. It prompts before sudo,
login, replacing configuration, and enabling repository Git hooks. It prefers the MFIQ.ai group
when available, but lets the operator choose. The linking QR is also saved at
.signal-control-tower/signal-link.png.

Then:

~~~bash
npx --yes github:PJensen/signal-control-tower doctor
npx --yes github:PJensen/signal-control-tower run
~~~

Commands use the current directory's signal-control-tower.json; pass --config PATH when it is
elsewhere. The runner prints the verified Signal group and MCP address when it starts.

## CLI

~~~text
signal-control-tower setup [setup options]
signal-control-tower doctor [--config PATH]
signal-control-tower run [--config PATH] [--mode MODES]
signal-control-tower send [--config PATH] [--file PATH] [--message TEXT] [--title TEXT]
~~~

doctor validates configuration, Codex/Entire executables, the Git workspace, and the Signal group
without entering the long-running listener. run starts the listener. --mode accepts a
comma-separated subset of ask, feature, and dispatch; omitting it enables all supported
capabilities. The restriction is enforced at runtime and reflected in startup announcements and
/help.

send queues a delivery for the configured group; it does not open a second Signal connection.
Use --message, --file, or both. Files must be regular files no larger than 25 MB. The running tower
retries queued deliveries after transient failures.

~~~bash
npx --yes github:PJensen/signal-control-tower doctor --config ./signal-control-tower.json
npx --yes github:PJensen/signal-control-tower run --mode ask,feature
npx --yes github:PJensen/signal-control-tower send --file report.md \
  --title "Underwriting architecture"
~~~

## Configuration

Copy [signal-control-tower.example.json](signal-control-tower.example.json) and replace the
placeholder values. Paths are resolved relative to the configuration file unless absolute.

~~~json
{
  "signal": {
    "account": "+15555550100",
    "groupId": "replace-with-signal-group-id",
    "groupName": "Signal Control Tower",
    "allowedSenders": ["+15555550101"],
    "executable": "signal-cli"
  },
  "codex": {
    "executable": "codex",
    "model": "gpt-5.6-terra",
    "reasoningEffort": "medium",
    "extraArgs": []
  },
  "entire": { "executable": "entire" },
  "stateDirectory": ".signal-control-tower",
  "workspace": {
    "path": "../app",
    "allowWrite": true,
    "validateCommand": ["npm", "run", "test"],
    "shipCommands": [
      ["npm", "install"],
      ["npm", "run", "test"],
      ["npm", "run", "migrate:remote"],
      ["npm", "run", "deploy"]
    ]
  },
  "mcp": { "host": "127.0.0.1", "port": 8765 }
}
~~~

Key semantics:

- signal.account is the local account used by signal-cli. groupId and groupName must identify
  the same group; a mismatch stops startup. allowedSenders is a non-empty allow-list.
- signal.dataDirectory optionally selects the signal-cli data directory.
- codex.extraArgs is appended to every Codex invocation. Model and reasoning effort are also passed
  through.
- workspace.allowWrite controls write-task access. Questions always run read-only.
- workspace.validateCommand runs in the workspace after every successful write task; failure makes
  the work item fail.
- workspace.shipCommands runs in order for /ship. The final command is treated as deployment;
  preceding commands are preparation and validation.
- stateDirectory contains durable state and should remain private and Git-ignored.
- mcp.host and mcp.port configure the MCP listener, defaulting to loopback and port 8765.

The setup-created configuration is owner-only. Runtime state can contain local paths, operational
metadata, queued messages, and archived attachment bytes, so do not commit or share it.

## Manual setup

If you do not use the interactive bootstrap, install Deno 2.x, signal-cli, an authenticated Codex
CLI, Git, and Entire yourself. Then create a configuration in the working directory:

~~~bash
cp signal-control-tower.example.json signal-control-tower.json
deno task validate
deno task doctor -- --config signal-control-tower.json
deno task start -- --config signal-control-tower.json
~~~

Replace the Signal account, group ID/name, allowed senders, and workspace path before running the
doctor. The configured Signal account must already be linked in signal-cli, and the workspace must
be an accessible Git checkout. Set signal.dataDirectory if signal-cli does not use its default
data location.

## Signal commands

Only messages from the configured group and allowed senders are accepted. Unknown or malformed
commands receive an error response. /codex and /ask accept at most 20,000 characters.

| Command | Purpose |
| --- | --- |
| /codex <task> | Queue a build or fix task. Multiline instructions go on the next line. |
| /ask <question> | Queue a read-only code question; multiline questions go on the next line. |
| /status [id] | Show the sender's latest work item or a selected item. |
| /cancel [id] | Request cancellation of the sender's queued or running item. |
| /ship | Preserve local changes, refresh main, run shipCommands, and deploy. |
| /feature <idea> | Record a request under docs/features/; GitHub issue creation may also be attempted. |
| /capture start [title] | Start capturing the sender's ordinary messages and available attachments. |
| /capture status | Show the active capture and message count. |
| /capture done | Export a verbatim transcript to docs/context/inbox/. |
| /capture cancel | Stop capturing; messages remain in the audit log. |
| /dispatch [flags] | Generate a recent entire dispatch summary. |
| /context | Show workspace, write mode, and validation configuration. |
| /help | Show commands enabled for the current startup mode. |

/dispatch accepts --local, --repos VALUE, --agent VALUE, --since VALUE, --until VALUE,
--voice VALUE, --all-branches, and --help. It defaults to local generation with neutral voice.
--repos cannot be combined with --local, --agent, or --all-branches.

While a capture is active, only its status, done, and cancel commands are accepted for that sender.
Ordinary messages and available attachment bytes are stored in restart-safe state. Completion copies
attachments below docs/context/inbox/assets/ and writes the source transcript; commands are excluded.
The transcript is evidence with provenance, not an AI-authored decision record.

## Attachments and artifacts

Inbound attachments are recorded with metadata and, when a local file is available, archived in the
event log with size and SHA-256 information. Attachments on /codex and /ask are metadata-only in
the intake stage; Codex is told not to claim it inspected their bytes. Context capture archives
available bytes into its state and workspace assets.

Codex can request workspace files in its final response by placing this on its own line:

~~~text
ATTACHMENT: relative/path/to/file.pdf
~~~

Requested paths must be regular files inside the configured workspace. At most five files of 25 MB
each are returned. /ask can return an existing file but cannot modify the workspace.

## Persistence and shutdown

The default state layout is:

~~~text
.signal-control-tower/
├── captures/                 # active sessions and capture attachments
├── logs/events.jsonl         # owner-only JSONL audit trail
│   └── attachments/          # archived attachment bytes
├── outbox/                   # durable outbound deliveries and retries
├── work-items.json           # work-item records
└── signal-link.png           # setup-created linking QR, when applicable
~~~

The audit trail records accepted and rejected input, parsed commands, subprocess output, work
lifecycle events, errors, outbound messages, dispatches, and shutdown events. On SIGINT or SIGTERM,
the runner records the request, attempts a shutdown announcement, closes the outbox and MCP server,
and stops the Signal subprocess.

## MCP integration

While running, the daemon exposes:

~~~text
http://127.0.0.1:8765/mcp
~~~

Available tools are signal_send_message (queue text), signal_send_file (queue a workspace file
with an optional message/title), and signal_outbox_status (report destination/workspace). File paths
are resolved against the real workspace and traversal or symlink escapes are rejected. Keep MCP
loopback-only unless you add authentication and network controls.

## Development

No dependency install is required. With Deno 2.x:

~~~bash
deno task check       # format, lint, and type check
deno task test        # test suite
deno task validate    # check + test
deno task doctor -- --config signal-control-tower.json
deno task start -- --config signal-control-tower.json
~~~

Source is in src/; tests are in tests/; setup is src/setup.mjs; and the package launcher is
bin/signal-control-tower.mjs. Before merging or tagging, run deno task validate, update the
Unreleased section of [CHANGELOG.md](CHANGELOG.md), and tag only after CI passes.

## Security and limitations

This is for a trusted, operator-controlled laptop and Signal group, not a hosted multi-tenant
service. Safeguards include group/sender allow-listing, read-only questions, workspace-bound
artifact validation, loopback MCP binding, owner-only runtime state, and mandatory write-task
validation.

Review shipCommands carefully: they execute local commands and the last command is deployment.
Protect the config and state directory, protect the Signal account, and do not expose MCP publicly
without additional controls.

## Project status

The package is currently private and versioned 0.0.0 in package.json; it is distributed for direct
GitHub/NPX use. See [CHANGELOG.md](CHANGELOG.md) for development history.
