# Phase 4 Design: Stop "Continue" Button + Interactive Setup Improvements

## Date: 2026-02-24
## Version target: v0.8.0
## Branch: add-notifications

---

## Feature A: Stop Hook "Continue" Button (PRD 5.8)

### Overview

Transform the Stop notification from fire-and-forget into an optional interactive prompt with a "Continue" button. When the user taps Continue, Claude is told to keep going. On timeout, Claude proceeds with stop normally. Controlled by `config.notifications.stopWithContinue` (default false).

### New module: `src/stop.mjs`

Exports `processStop(input, deps)` and `buildContinueAction(server, topic, requestId, opts)`.

**processStop flow:**

1. Load config, check `topic` and `notifications.stopWithContinue` — return `null` if either missing/disabled
2. Generate `requestId`, build a single "Continue" action via `buildContinueAction`
3. Send notification via `sendWithRetry`:
   - Title: "Claude Code"
   - Message: "Claude has finished responding"
   - Priority: 3, Tags: `["white_check_mark"]`
   - Actions: single Continue button
4. Call `waitForResponse` with `continueTimeout` (defaults to `timeout` if unset)
5. On response with `continue: true` → return `{ decision: "block", reason: "User requested continuation" }`
6. On timeout/error/no response → return `null`

**buildContinueAction:**

Follows the `buildActions` pattern. Constructs an HTTP action:
- Label: "Continue"
- URL: `${server}/${topic}-response`
- Body: `{ requestId, continue: true }`
- Auth header injected when `authToken` is present

### CLI routing

New `stop` case in `bin/cli.mjs`:
- Reads stdin JSON, calls `processStop(input, deps)`
- If result is non-null, writes JSON to stdout
- If result is null, writes nothing (exit 0)
- Added to `needsStdin` check list

New `getStopCommand()` in `src/setup.mjs` returns `"node <abs_path>/bin/cli.mjs stop"`.

### Hook registration

In `registerNotificationHooks`, when processing the `stop` config key:
- If `stopWithContinue` is true → register Stop hook with the `stop` command
- If `stopWithContinue` is false → register Stop hook with the `notify` command

### Config changes

- Add `continueTimeout` to `DEFAULT_CONFIG` (default: 120)
- Add `CCR_CONTINUE_TIMEOUT` env var override in `applyEnvOverrides`

### Context injection

Update `generateContext` in `src/context.mjs` to mention the Continue button when `stopWithContinue` is enabled.

---

## Feature B: Interactive Setup Improvements (PRD 4.7)

### HTTPS enforcement

New `isInsecureServer(server)` function in `src/config.mjs`:
- Returns `true` if URL scheme is `http://` and hostname is not `localhost`, `127.0.0.1`, or `::1`

In `runSetup`, after assembling config but before saving:
- If `isInsecureServer(config.ntfyServer)` and neither `--allow-insecure` CLI flag nor `config.allowInsecure` is set → throw with message explaining the risk and how to override
- If override is set → warn to stderr but proceed
- `allowInsecure` added to `DEFAULT_CONFIG` (default: false), persisted in config

CLI flag: `bin/cli.mjs` parses `--allow-insecure` from args when command is `setup`, passes to `runSetup`. If present, sets `config.allowInsecure = true`.

### Token validation

New `validateToken(fetchFn, server, topic, authToken)` function in `src/ntfy.mjs`:
1. POST to `${server}/${topic}` with `Authorization: Bearer ${authToken}` and minimal body (empty message, priority 1)
2. Returns `{ valid: true }` on 2xx
3. Returns `{ valid: false, status, message }` on 401/403 or other HTTP errors
4. Returns `{ valid: false, message }` on network error

In `runSetup`, after HTTPS check, if `authToken` is non-empty:
- Call `validateToken`. On failure → throw with status/message, don't save config
- On success → proceed

### Updated setup flow order

1. Generate topic (if not already set)
2. HTTPS enforcement check
3. Token validation (if authToken present)
4. Save config
5. Register hooks (PermissionRequest, notifications, context, stop)

Bad config is never persisted.

---

## Testing

### New: `test/stop.test.mjs`

- Happy path: Continue tapped → returns block decision
- Timeout: waitForResponse times out → returns null
- Network error: sendWithRetry fails → returns null
- Disabled: stopWithContinue false → returns null without sending
- No topic: returns null
- Auth token threading: verify in sendNotification, waitForResponse, action headers
- buildContinueAction: with and without authToken

### Extended: `test/setup.test.mjs`

- validateToken: success, 401, 403, network error
- HTTPS enforcement: http non-localhost refused, http localhost allowed, https allowed, allowInsecure override, --allow-insecure flag
- runSetup aborts before save on validation failure
- runSetup aborts before save on HTTPS refusal
- Stop hook registered as stop command vs notify command based on stopWithContinue

### Extended: `test/ntfy.test.mjs`

- validateToken unit tests with mock fetch

### Extended: `test/cli.test.mjs`

- stop command routing, stdin handling, stdout output

---

## Error handling

| Scenario | Behavior |
|---|---|
| Stop + stopWithContinue disabled | Exit 0, no output (fire-and-forget via notify) |
| Stop + stopWithContinue + timeout | Exit 0, no output (Claude proceeds with stop) |
| Stop + stopWithContinue + network error | Exit 0, no output, stderr log |
| Stop + Continue tapped | Stdout: `{"decision":"block","reason":"..."}` |
| Setup + http non-localhost + no override | Throw, don't save config |
| Setup + http non-localhost + override | Warn to stderr, proceed |
| Setup + bad token | Throw with status/message, don't save config |
| Setup + no token | Skip validation, proceed |

---

## Files changed

| File | Change |
|---|---|
| `src/stop.mjs` (NEW) | processStop, buildContinueAction |
| `src/ntfy.mjs` | Add validateToken |
| `src/config.mjs` | Add continueTimeout, allowInsecure defaults; add isInsecureServer; add CCR_CONTINUE_TIMEOUT env override |
| `src/setup.mjs` | Add getStopCommand; conditional stop registration; HTTPS check; token validation in runSetup |
| `src/context.mjs` | Mention Continue button when stopWithContinue enabled |
| `bin/cli.mjs` | Add stop command; parse --allow-insecure; add stop to needsStdin |
| `test/stop.test.mjs` (NEW) | processStop and buildContinueAction tests |
| `test/setup.test.mjs` | HTTPS enforcement, token validation, stop registration tests |
| `test/ntfy.test.mjs` | validateToken tests |
| `test/cli.test.mjs` | stop command routing tests |
