# Manual Test Plan — Self-Hosted ntfy

Prereqs: `setup` completed with self-hosted server, auth token configured,
ntfy app subscribed to the topic shown in setup output.

## 1. Status check

Verify config is correct before sending anything.

```bash
node bin/cli.mjs status
```

**Expected:** Server shows self-hosted URL, Auth shows token prefix with `(configured)`,
topic is present, notification flags match config.

## 2. Test notification (basic connectivity + auth)

```bash
node bin/cli.mjs test
```

**Expected:** CLI prints `Test notification sent successfully.` and notification arrives
on phone in ntfy app.

## 3. Fire-and-forget notifications

These simulate the hook events Claude Code would pipe via stdin. Each enabled
notification type should arrive on the phone with no response expected.

### 3a. Idle (Notification event)

```bash
echo '{"hook_event_name":"Notification","notification":{"title":"Idle","body":"Claude is waiting for input"}}' \
  | node bin/cli.mjs notify
```

**Expected:** Notification with title "Idle", body "Claude is waiting for input",
hourglass emoji tag, priority 4.

### 3b. Stop (finished)

```bash
echo '{"hook_event_name":"Stop"}' | node bin/cli.mjs notify
```

**Expected:** Notification with title "Claude Code", body "Claude has finished
responding", checkmark tag, priority 3.

### 3c. Tool failure

```bash
echo '{"hook_event_name":"PostToolUseFailure","tool_name":"Bash","error":"Command timed out after 120s"}' \
  | node bin/cli.mjs notify
```

**Expected:** Notification with title "Tool Failed: Bash", body "Command timed out
after 120s", warning+x tags, priority 4.

### 3d. Session start (disabled by default)

```bash
echo '{"hook_event_name":"SessionStart"}' | node bin/cli.mjs notify
```

**Expected:** No notification sent (sessionStart is `false` in config). No output, no
error.

## 4. Permission request hook (interactive)

This simulates a PermissionRequest. The hook sends a notification with
Approve/Deny buttons and blocks waiting for a response via SSE. Since we can't
easily tap the button and have the SSE complete in a test, we verify:

- The notification arrives on phone with action buttons
- The hook times out gracefully when no button is tapped

### 4a. Bash tool permission

```bash
echo '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm -rf /tmp/test","description":"Delete test files"}}' \
  | timeout 15 node bin/cli.mjs hook
```

**Expected:** Notification arrives with title containing "Bash", body showing the
command `rm -rf /tmp/test`, with Approve/Deny/Always Approve buttons. After timeout
(15s forced), CLI outputs `{"behavior":"ask"}` fallback JSON.

### 4b. Read tool permission (no Always Approve)

```bash
echo '{"hook_event_name":"PermissionRequest","tool_name":"Read","tool_input":{"file_path":"/etc/passwd"}}' \
  | timeout 15 node bin/cli.mjs hook
```

**Expected:** Notification with title containing "Read", body showing `/etc/passwd`,
Approve/Deny buttons (no Always Approve since no `permissionSuggestions`). Timeout
produces fallback JSON.

## 5. Disable / Enable cycle

```bash
node bin/cli.mjs disable
grep "claude-remote-approver" ~/.claude/settings.json; echo "exit: $?"
# Expected: exit 1 (no matches)

node bin/cli.mjs enable
grep "claude-remote-approver" ~/.claude/settings.json; echo "exit: $?"
# Expected: exit 0 (hooks re-registered)
```

## 6. Status after re-enable

```bash
node bin/cli.mjs status
```

**Expected:** Same output as test 1, confirming config survived disable/enable.
