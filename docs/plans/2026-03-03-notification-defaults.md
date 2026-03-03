# Proposal: Adjust Default Notification Settings

**Date:** 2026-03-03
**Branch:** add-notifications
**Status:** Draft

## Problem

Two issues with current default notification behavior:

1. **Idle spam** — The `Notification` hook fires "Waiting for input" after
   nearly every action, even when Claude is still working (e.g. between
   subagent dispatches, parallel tool calls, or mid-plan). The hook event
   fires whenever Claude Code's UI shows the idle prompt, which doesn't
   necessarily mean Claude is truly waiting for the user.

2. **Noisy defaults** — `toolFailure` notifications are on by default.
   Bash command failures and other tool errors are common during normal
   operation (e.g. grep finding no matches, test runs with failures) and
   don't warrant a phone notification.

## Current Defaults (`DEFAULT_CONFIG.notifications`)

```js
idle: true,           // ← problem 1
stop: true,
sessionStart: false,
sessionEnd: false,
toolFailure: true,    // ← problem 2
subagentStop: false,
stopWithContinue: false,
```

## Proposed Changes

### Change 1: Disable idle notifications by default

```js
idle: false,  // was: true
```

**Rationale:** The `Notification` hook event from Claude Code is too
coarse — it fires on every UI idle, not just when Claude is genuinely
blocked waiting for user input. Until Claude Code provides a way to
distinguish "truly idle" from "briefly idle between actions", this
notification creates more noise than value. Users who want it can
enable it in config.

**Future:** If Claude Code adds richer notification metadata (e.g. a
`reason` field distinguishing "waiting_for_user" from "between_steps"),
we could re-enable this with filtering. For now, the `Stop` notification
already covers the most important case: "Claude is done."

### Change 2: Disable toolFailure notifications by default

```js
toolFailure: false,  // was: true
```

**Rationale:** Tool failures during normal operation (grep no-match,
test failures, command errors that Claude retries) are routine and don't
need phone notifications. The permission request hook already covers
the interactive case. Users running long unattended jobs who want
failure alerts can opt in.

### Change 3: Unregister disabled notification hooks

Currently, `registerNotificationHooks` in `setup.mjs` only registers
hooks for enabled notification types, so changing defaults means new
installs won't get these hooks. **No hook registration changes needed.**

However, existing installs that run `setup` again will get the new
defaults, which will naturally not register hooks for disabled types.

## Implementation

### Files to change

| File | Change |
|------|--------|
| `src/config.mjs` | `idle: false`, `toolFailure: false` in `DEFAULT_CONFIG` |
| `test/notify.test.mjs` | Update any tests that assume `idle: true` or `toolFailure: true` defaults |
| `test/cli.test.mjs` | Update any `createDeps` default configs if they reference these |

### What does NOT change

- `formatNotification()` — still handles all event types when enabled
- `processNotify()` — config-gated logic is already correct
- Hook registration — already conditional on config flags
- `Stop` notification — stays enabled (this is the useful one)

## Scope

This is a defaults-only change. No new features, no new config keys,
no behavioral changes for users who have already configured their
preferences. Existing config files are not modified — `loadConfig()`
merges file config over defaults, so existing `idle: true` settings
will be preserved.

## Prompt for next session

```
Change the default notification settings in claude-remote-approver:

1. In src/config.mjs DEFAULT_CONFIG.notifications, set idle to false
   and toolFailure to false.
2. Update tests in test/notify.test.mjs and test/cli.test.mjs that
   depend on these defaults being true.
3. Run npm test to verify all 428+ tests pass.

See docs/plans/2026-03-03-notification-defaults.md for full rationale.
```
