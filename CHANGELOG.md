# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Restart-safe `/capture` sessions that preserve an SME's ordinary Signal messages and available
  attachments, then export a provenance-rich verbatim transcript into `docs/context/inbox/`.
- An owner-only JSONL event log for Signal input/output and Entire dispatch subprocesses, including
  archived attachment content with hashes when a local attachment file is available.
- Graceful shutdown capture and a Signal channel announcement for `SIGINT` and `SIGTERM`.
- Signal subprocess isolation so terminal interrupts leave the connection alive long enough to
  deliver the shutdown announcement, with closed JSON-RPC pipes handled without crashing.
- One authoritative capability set for startup announcements, command enforcement, and `/help`;
  omitting `--mode` enables the full protocol while an explicit mode list restricts it.
- Startup mode selection for `ask`, `feature`, and `dispatch`, plus a Signal channel announcement
  listing the enabled capabilities when the tower comes online.
- A durable `send` command for delivering local messages and Markdown documents to the configured
  Signal group through the running tower.
- Initial Signal-to-Codex control daemon.
- Interactive NPX bootstrap for provisioning Signal, Codex, Deno, the MFIQ project, and local
  runtime configuration.
- Clone-free setup and operation directly from the GitHub repository through NPX.

### Changed

- Renamed the project to Signal Control Tower.
- Preserve complete Codex answers and deliver long responses as ordered Signal-safe messages.
