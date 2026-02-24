# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Remote Approver is a Node.js CLI tool that lets users approve or deny Claude Code permission prompts remotely from their phone via ntfy.sh notifications. It works as a Claude Code hook: Claude Code pipes JSON to stdin, the hook sends a notification with action buttons, waits for the user's response via SSE, and writes the decision as JSON to stdout.

## Commands

```bash
npm ci                          # Install dependencies
npm test                        # Run all tests (node --test test/*.test.mjs)
node --test test/hook.test.mjs  # Run a single test file
node bin/cli.mjs <command>      # Run CLI directly (setup|test|status|enable|disable|uninstall|hook)
```

CI runs tests on Node 18, 20, and 22. npm publish is triggered by pushing a `v*` tag.

## Architecture

Pure ESM codebase (`"type": "module"`) with zero dev dependencies. Only production dependency is `qrcode-terminal` for setup QR codes. Everything else uses Node built-ins (`node:fs`, `node:crypto`, `node:test`, `node:assert/strict`, fetch API).

### Module Dependency Graph

```
bin/cli.mjs  (entry point, command router, stdin/stdout I/O)
  ├── src/config.mjs   (loadConfig, saveConfig, generateTopic)
  ├── src/ntfy.mjs     (sendNotification, waitForResponse, formatToolInfo, stripMarkdown)
  ├── src/hook.mjs     (processHook, processAskUserQuestion, buildActions, sendWithRetry)
  └── src/setup.mjs    (registerHook, unregisterHook, runSetup, getHookCommand)
```

### Key Patterns

**Dependency injection everywhere.** All modules export pure functions. `cli.mjs` constructs a `deps` object and passes it through — no module-level mocking needed. Tests create mock `deps` objects with tracked calls.

**Two hook event types:**
- `PermissionRequest` — tool permission prompts (Bash, Read, Write, etc.). Returns `{behavior: "allow"|"deny"|"ask"}`. "Always Approve" returns `updatedPermissions` for Claude Code to persist.
- `AskUserQuestion` — question prompts with up to N options, split across multiple notifications if >3 options. Returns `updatedInput` with selected answers.

**ntfy.sh two-topic protocol:**
- Main topic (`config.topic`): receives notifications with action buttons
- Response topic (`config.topic-response`): SSE stream where button taps arrive, matched by `requestId` (UUID)

**Fallback behavior:** On timeout or network error, returns `{"behavior": "ask"}` so Claude Code falls back to its CLI prompt. Timeouts: 120s default, 300s for `ExitPlanMode`.

**Message formatting:** `formatToolInfo` extracts display-friendly info per tool type (Bash→command, Read/Write/Edit→file_path, ExitPlanMode→stripped plan text). All messages truncated to 1000 chars to prevent ntfy send failures.

**Retry logic:** `sendWithRetry` does 3 attempts with linear backoff (1s, 2s, 3s delays).

### Config

Stored at `~/.claude-remote-approver.json` with `0o600` permissions. Hook registered in `~/.claude/settings.json` under `hooks.PermissionRequest`.

## Testing

Uses Node's built-in test runner (`node:test`) with `node:assert/strict`. Tests use `t.mock.fn()` for mocking. Each source module has a corresponding test file. Helper functions like `createMockFetch` and `createSSEStream` build mock infrastructure for HTTP/SSE testing.
