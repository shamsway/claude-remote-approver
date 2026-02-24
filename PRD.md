# PRD: Expanded Notification & Interaction Support

## Status: Draft (Rev 2)
## Author: Generated from codebase analysis + research
## Date: 2026-02-24
## Primary deployment target: Self-hosted ntfy

---

## 1. Background

Claude Remote Approver (v0.6.2) currently supports two interaction types via ntfy.sh:

1. **PermissionRequest** — Binary approve/deny (with optional "Always Approve") for tool permission prompts
2. **AskUserQuestion** — Multiple-choice question answering, split across notifications when >3 options

Both flow through the `PermissionRequest` hook event. The tool has no support for non-interactive (fire-and-forget) notifications, and the question flow is limited to the 3-button-per-notification constraint of ntfy.sh.

### What Users Are Asking For

GitHub issues on the Claude Code repo (#15872, #12605, #10168, #13024) show demand for:
- Immediate notifications when Claude is waiting for input (the built-in `Notification` hook fires after 60s idle — too slow)
- Remote notification when a session completes or errors
- Richer question/answer flows beyond tapping a single button

---

## 2. Goals

1. **First-class self-hosted ntfy support** with API auth token for publish, subscribe, and action button callbacks
2. **Add notification-only hooks** for session lifecycle events (start, stop, errors, idle) that inform the user without requiring a response
3. **Expand the approval flow** to support richer multi-choice question interactions from Claude Code
4. **Maintain the zero-dependency, pure-function architecture** and dependency injection patterns
5. **Keep the fallback-to-CLI guarantee** — every interactive flow degrades gracefully on timeout or error

## 3. Non-Goals

- Building a full bidirectional chat interface over ntfy.sh
- Supporting free-text input from the user (ntfy.sh actions are button-only; no text fields)
- Replacing the CLI permission prompt — this remains a remote supplement
- Supporting ntfy.sh Pro-only features (voice calls, reserved topics)
- Mobile app development
- Supporting username/password auth (token-only; simpler, more secure, no plaintext passwords in config)

---

## 4. Feature 0: Self-Hosted ntfy Auth Token Support

### 4.1 Problem

The current codebase assumes open/unauthenticated ntfy topics (the ntfy.sh cloud default). Self-hosted ntfy servers typically run with `auth-default-access: deny-all`, requiring authentication for all publish and subscribe operations. Without auth support, the tool is unusable on locked-down self-hosted instances.

### 4.2 Auth Model

ntfy supports several auth methods. We will support **Bearer token auth** (`Authorization: Bearer tk_...`), which is the recommended approach for programmatic access:

- Tokens are 32 characters, always prefixed with `tk_`
- Created via `ntfy token add <username>` on the server
- Each user can have up to 60 tokens
- Tokens can have optional expiry dates and labels
- Tokens currently grant full access to the user account (per-topic token scoping is planned by ntfy but not yet implemented)

We will **not** support username/password Basic auth — token auth is simpler, avoids plaintext passwords in config, and is the ntfy project's recommended programmatic approach.

### 4.3 Where Auth Is Needed

There are **three distinct HTTP call sites** that each need auth:

| Call Site | Direction | Current Code | Auth Needed |
|---|---|---|---|
| **Publish** to main topic | Server → ntfy | `sendNotification()` POST | `Authorization: Bearer tk_...` header |
| **Subscribe** to response topic | Server → ntfy | `waitForResponse()` GET (SSE) | `Authorization: Bearer tk_...` header |
| **Action button callback** to response topic | User's phone → ntfy | ntfy app executes HTTP action | Token embedded in action definition |

The third call site is the critical one. When a user taps "Approve" on their phone, the **ntfy app itself** makes the HTTP POST to the response topic. The ntfy app does **not** auto-inject any auth credentials — it only sends headers explicitly defined in the action's `headers` field.

### 4.4 Action Button Auth Strategy

Action button definitions must include auth for protected servers. Two approaches:

**Option A: `headers` field in action definition (recommended)**
```json
{
  "action": "http",
  "label": "Approve",
  "url": "https://ntfy.example.com/cra-abc123-response",
  "method": "POST",
  "headers": { "Authorization": "Bearer tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2" },
  "body": "{\"requestId\": \"...\", \"approved\": true}",
  "clear": true
}
```

**Option B: `?auth=` query parameter in URL**
```json
{
  "action": "http",
  "label": "Approve",
  "url": "https://ntfy.example.com/cra-abc123-response?auth=QmVhcmVyIHRrX0FnUWRx...",
  "method": "POST",
  "body": "{\"requestId\": \"...\", \"approved\": true}"
}
```

The `?auth=` value is `base64_raw("Bearer tk_...")` (standard base64 with trailing `=` stripped).

**Recommendation: Option A** (`headers` field). It's more readable in debug logs, and the action definition payload is already private to the topic (which itself is a 128-bit secret). Option B is available as a fallback if any ntfy client has issues with custom headers on action callbacks.

### 4.5 Security Considerations

- **Token in notification payload**: The auth token is embedded in action button definitions, which are stored in ntfy's message cache (12 hours by default). Anyone with read access to the main topic can see the token. This is acceptable because the main topic name is already a 128-bit secret (`cra-<32 hex chars>`), so topic-name secrecy is the primary access control layer regardless.
- **Config file permissions**: The token is stored in `~/.claude-remote-approver.json` which is already written with mode `0o600` (owner-only read/write).
- **Token scope**: ntfy tokens currently grant full user-level access (not per-topic). Users should create a dedicated ntfy user with ACL entries scoped to `cra-*` topics only.
- **HTTPS required**: Bearer tokens are transmitted in cleartext over HTTP. The setup flow should warn (or refuse) if the server URL is `http://` without `localhost`.

### 4.6 Config Changes

Add an optional `authToken` field:

```json
{
  "topic": "cra-...",
  "ntfyServer": "https://ntfy.example.com",
  "authToken": "tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2",
  "timeout": 120,
  "planTimeout": 300
}
```

When `authToken` is present, all three call sites inject it. When absent, behavior is unchanged (unauthenticated, compatible with ntfy.sh cloud).

### 4.7 Setup Flow Changes

The `setup` command should:

1. Prompt for ntfy server URL (existing)
2. **New**: Ask if the server requires authentication
3. If yes, prompt for the access token (`tk_...`)
4. **New**: Validate the token by attempting a publish + subscribe round-trip to a test topic
5. If validation fails, show the error and suggest checking the token and server ACLs
6. If the server URL is `http://` (not HTTPS, not localhost), warn that tokens will be sent in cleartext

### 4.8 Recommended Server-Side ACL Setup

Document the recommended ntfy server configuration for use with claude-remote-approver:

```bash
# Create a dedicated user
ntfy user add claude-approver

# Create an access token
ntfy token add --label="claude-remote-approver" claude-approver
# Output: tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2

# Grant read-write to all cra-* topics
ntfy access claude-approver "cra-*" rw
```

Server config (`server.yml`):
```yaml
auth-file: /var/lib/ntfy/user.db
auth-default-access: deny-all
```

### 4.9 Code Changes

**`src/ntfy.mjs`** — `sendNotification()` and `waitForResponse()`:
```javascript
// sendNotification: add Authorization header when authToken present
const headers = { 'Content-Type': 'application/json' };
if (authToken) {
  headers['Authorization'] = `Bearer ${authToken}`;
}

// waitForResponse: add Authorization header to SSE subscription
const sseHeaders = {};
if (authToken) {
  sseHeaders['Authorization'] = `Bearer ${authToken}`;
}
```

**`src/hook.mjs`** — `buildActions()` and `buildQuestionActions()`:
```javascript
// Inject auth header into every http action definition
function buildActions(server, topic, requestId, { permissionSuggestions, authToken }) {
  const action = {
    action: 'http',
    label: 'Approve',
    url: `${server}/${topic}-response`,
    method: 'POST',
    body: JSON.stringify({ requestId, approved: true }),
    clear: true,
  };
  if (authToken) {
    action.headers = { Authorization: `Bearer ${authToken}` };
  }
  // ... same for Deny, Always Approve buttons
}
```

### 4.10 Testing

- Test that `authToken` is included in fetch headers for publish and subscribe
- Test that `authToken` is included in action button definitions when present
- Test that no auth headers are sent when `authToken` is absent (backward compat)
- Test setup validation round-trip (mock fetch for success/401 scenarios)
- Test `http://` non-localhost warning

---

## 5. Feature 1: Non-Interactive Notification Hooks

### 5.1 Overview

Register additional Claude Code hooks that send fire-and-forget ntfy.sh notifications. These do not wait for a response and do not block Claude Code.

### 5.2 New Notification Types

| Hook Event | Notification | Priority | Tags (emoji) | When |
|---|---|---|---|---|
| `Notification` (matcher: `idle_prompt`) | "Claude is waiting for your input" | `4` (high) | `hourglass_flowing_sand` | Claude idle >60s waiting for input |
| `Notification` (matcher: `permission_prompt`) | "Claude needs permission approval" | `4` (high) | `bell` | Permission dialog appeared (redundant with existing hook, but useful as a supplementary push) |
| `Stop` | "Claude has finished" | `3` (default) | `white_check_mark` | Claude finishes responding (session turn complete) |
| `SessionStart` | "Claude session started" | `2` (low) | `rocket` | New session begins |
| `SessionEnd` | "Claude session ended" | `2` (low) | `stop_sign` | Session terminates |
| `PostToolUseFailure` | "Tool failed: {tool_name}" | `4` (high) | `warning`, `{tool_name}` | A tool call failed |
| `SubagentStop` | "Subagent finished: {agent_type}" | `2` (low) | `robot_face` | A subagent completes |

### 5.3 Configuration

Users should be able to enable/disable each notification type individually. Extend the config schema:

```json
{
  "topic": "cra-...",
  "ntfyServer": "https://ntfy.sh",
  "timeout": 120,
  "planTimeout": 300,
  "notifications": {
    "idle": true,
    "stop": true,
    "sessionStart": false,
    "sessionEnd": false,
    "toolFailure": true,
    "subagentStop": false
  }
}
```

Defaults should favor "useful but not noisy" — `idle`, `stop`, and `toolFailure` enabled by default; lifecycle events disabled.

### 5.4 Hook Registration

Each notification type requires its own hook entry in `~/.claude/settings.json`. The `setup` command should register all enabled hooks. Example:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [{ "type": "command", "command": "claude-remote-approver hook" }]
      }
    ],
    "Notification": [
      {
        "matcher": "idle_prompt",
        "hooks": [{ "type": "command", "command": "claude-remote-approver notify" }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "claude-remote-approver notify" }]
      }
    ],
    "PostToolUseFailure": [
      {
        "hooks": [{ "type": "command", "command": "claude-remote-approver notify" }]
      }
    ]
  }
}
```

### 5.5 New CLI Command: `notify`

A new subcommand `claude-remote-approver notify` that:

1. Reads hook JSON from stdin (same as `hook`)
2. Determines notification type from `hook_event_name`
3. Checks config to see if this notification type is enabled
4. Sends a one-way ntfy.sh notification (no SSE subscription, no response waiting)
5. Exits immediately with code 0 and no stdout output

This command is fire-and-forget. Errors are logged to stderr but never block Claude Code.

### 5.6 Notification Formatting

Each notification type needs a formatter function. Extend `formatToolInfo` or create a parallel `formatNotification` function:

```javascript
function formatNotification(input) {
  switch (input.hook_event_name) {
    case 'Notification':
      return { title: input.title || 'Claude Code', message: input.message };
    case 'Stop':
      return { title: 'Claude Code', message: 'Claude has finished responding' };
    case 'PostToolUseFailure':
      return {
        title: `Tool Failed: ${input.tool_name}`,
        message: truncate(input.error, 1000)
      };
    case 'SessionStart':
      return { title: 'Claude Code', message: `Session started (${input.source})` };
    case 'SessionEnd':
      return { title: 'Claude Code', message: `Session ended (${input.reason})` };
    case 'SubagentStop':
      return { title: 'Claude Code', message: `Subagent finished` };
  }
}
```

### 5.7 ntfy.sh Features to Use

For notification-only messages, leverage additional ntfy.sh features not currently used:

- **`priority`**: Map notification urgency (see table in 4.2)
- **`tags`**: Emoji tags for visual identification in the ntfy app
- **`icon`**: Optional — could use a Claude/Anthropic icon URL
- **`markdown`**: Enable for tool failure messages that may contain code
- **`click`**: Could link to the Claude Code web UI or relevant docs (stretch goal)

### 5.8 `Stop` Hook: "Continue" Action

The `Stop` hook is special — it supports blocking. When Claude finishes, the notification could include a single action button:

| Action | Behavior |
|---|---|
| **"Continue"** | Returns `{ "decision": "block", "reason": "User requested continuation" }` which forces Claude to keep going |

This transforms the "Claude finished" notification into an optional remote "keep going" prompt. To avoid blocking Claude indefinitely, use a short timeout (15-30s). On timeout, exit 0 with no output (allow stop).

This should be a separate config flag (`notifications.stopWithContinue: false` default) since it changes the `Stop` hook from fire-and-forget to interactive with a timeout.

---

## 6. Feature 2: Expanded Multi-Choice Question Flow

### 6.1 Current Limitations

The existing `AskUserQuestion` handler has these constraints:

1. **3 buttons max per ntfy.sh notification** — questions with >3 options are split across multiple notifications, but the user must scan all of them before tapping
2. **Single-select only in practice** — `multiSelect: true` is declared in the schema but the current implementation returns a single `answer` string per question
3. **No "Other" / free-text option** — Claude Code always offers an "Other" option for custom input, but ntfy.sh has no text input capability
4. **No question context** — option descriptions are shown in the message body but can be hard to read on mobile

### 6.2 Proposed Improvements

#### 6.2.1 Smarter Option Batching with Navigation

Instead of sending all batches simultaneously, send a paginated flow:

**Batch 1 of N:**
```
Which approach should we use? (1/3)

• Option A: Description...
• Option B: Description...
• Option C: Description...

[Option A] [Option B] [Option C]
```

If the user doesn't tap any button in batch 1, they can request more options. But ntfy.sh doesn't support pagination natively, so the current approach (send all batches at once) is actually the best we can do within ntfy.sh constraints.

**Improvement: Consolidate message formatting.** Currently batch messages show `(1/2)` numbering. Improve by:
- Adding total option count: `"(Options 1-3 of 7)"`
- Bolding the question text (with `markdown: true`)
- Adding a "Skip to CLI" button on each batch that returns `behavior: "ask"` so the user can answer via CLI instead

#### 6.2.2 Multi-Select Support

For `multiSelect: true` questions, the current implementation needs to collect multiple taps before returning. Proposed flow:

1. Send notification with options as buttons (max 3 per notification, batched as today)
2. Add a **"Done"** button to the final batch (or as a follow-up notification)
3. Collect all tapped answers into an array
4. On "Done" tap, return the accumulated selections

**Implementation detail:** The SSE listener must accumulate multiple responses with the same `requestId` instead of returning on first match. Add a `multiSelect` flag to the response body:

```json
// Button tap payload
{ "requestId": "...", "answer": "Option A", "multiSelect": true }

// Done button tap payload
{ "requestId": "...", "done": true }
```

The `waitForResponse` function collects answers until it receives `done: true` or hits the timeout:

```javascript
// Pseudocode
const answers = [];
while (!done && !timeout) {
  const event = await nextSSEEvent();
  if (event.done) break;
  if (event.answer) {
    if (answers.includes(event.answer)) {
      answers.splice(answers.indexOf(event.answer), 1); // toggle off
    } else {
      answers.push(event.answer);
    }
  }
}
return { answers };
```

**Confirmation notification:** After each tap, send a brief follow-up notification showing current selections: `"Selected: Option A, Option C. Tap Done to confirm."`

#### 6.2.3 "Answer on CLI" Fallback Button

For every question notification, add an action button that triggers fallback to the CLI prompt:

```json
{
  "action": "http",
  "label": "Use CLI",
  "url": "https://ntfy.sh/<topic>-response",
  "method": "POST",
  "body": "{\"requestId\": \"...\", \"useCLI\": true}",
  "clear": true
}
```

When `useCLI: true` is received, return `{ behavior: "ask" }` so Claude Code falls back to its built-in interactive prompt. This is important for questions where the user wants to type a custom "Other" response.

**Button budget:** This consumes 1 of 3 available buttons per notification. For questions with ≤2 options, all three slots are available (2 options + 1 "Use CLI"). For questions with 3+ options, batching already handles overflow, so "Use CLI" replaces one option slot in the last batch.

#### 6.2.4 Multi-Question Sequences

`AskUserQuestion` can include 1-4 questions in a single call. Currently the code processes the first question only. Expand to handle the full sequence:

1. Process questions sequentially — send notification for question 1, wait for answer, then question 2, etc.
2. Accumulate answers into the `answers` map: `{ "Question 1 text?": "Answer", "Question 2 text?": "Answer" }`
3. Return all answers in a single response

**Timeout handling:** Each question gets the full timeout window. If any question times out, fall back to CLI for the entire set.

#### 6.2.5 Preview Content Support

Claude Code's `AskUserQuestion` supports `markdown` preview content on options (shown in a side-by-side layout in the CLI). Since ntfy.sh supports markdown rendering, include preview content in the notification body when available:

```
Which layout do you prefer?

**Option A:**
```
┌─────────┐
│ Sidebar │ Content
└─────────┘
```

**Option B:**
```
┌──────────────┐
│   Top Nav    │
├──────────────┤
│   Content    │
└──────────────┘
```

[Option A] [Option B] [Use CLI]
```

Set `markdown: true` on these notifications.

---

## 7. Feature 3: Rich Notification Formatting

### 7.1 Markdown Support in Notifications

Enable `markdown: true` for all notifications. This improves readability for:
- Tool failure error messages (code snippets, stack traces)
- Plan review content (already stripped but could be lightly formatted)
- Question option descriptions

### 7.2 Priority Mapping

Map notification types to ntfy.sh priority levels:

| Context | Priority | Rationale |
|---|---|---|
| Permission request (existing) | `4` (high) | Blocks Claude, needs attention |
| Question (existing) | `4` (high) | Blocks Claude, needs attention |
| Tool failure | `4` (high) | May need user intervention |
| Idle prompt | `4` (high) | Claude is waiting |
| Stop (finished) | `3` (default) | Informational |
| Session start/end | `2` (low) | Background awareness |
| Subagent stop | `2` (low) | Background awareness |

### 7.3 Emoji Tags

ntfy.sh renders emoji shortcodes as icons in the notification list. Use consistent tags:

| Notification | Tags |
|---|---|
| Permission: Bash | `computer`, `lock` |
| Permission: Read/Write/Edit | `page_facing_up`, `lock` |
| Permission: ExitPlanMode | `clipboard`, `lock` |
| Question | `question` |
| Tool failure | `warning`, `x` |
| Idle | `hourglass_flowing_sand` |
| Stop | `white_check_mark` |
| Session start | `rocket` |
| Session end | `stop_sign` |

---

## 8. Architecture Changes

### 8.1 Module Changes

```
bin/cli.mjs           — Add "notify", "context", "prompt" command routing
src/config.mjs        — Extend config schema with authToken, notifications settings
src/ntfy.mjs          — Add formatNotification(), priority/tags/auth support in sendNotification()
src/hook.mjs          — Thread authToken, multi-select, multi-question, "Use CLI" button
src/notify.mjs (NEW)  — processNotify() for fire-and-forget notifications
src/context.mjs (NEW) — generateContext() for SessionStart hook injection
src/setup.mjs         — Auth prompts, register multiple hook events, notification config
```

### 8.2 sendNotification() Changes

Extend the existing `sendNotification` function to accept optional parameters:

```javascript
async function sendNotification({
  fetchFn, server, topic, title, message, actions,
  // New optional parameters:
  authToken,   // string, Bearer token for self-hosted auth
  priority,    // 1-5, default 3
  tags,        // string[] of emoji shortcodes
  markdown,    // boolean, default false
  icon,        // URL string, optional
}) { ... }
```

### 8.3 waitForResponse() Changes for Multi-Select

Add a `multiSelect` mode that accumulates answers:

```javascript
async function waitForResponse({
  fetchFn, server, topic, timeout, requestId,
  // New:
  authToken,    // string, Bearer token for self-hosted auth
  multiSelect,  // boolean — if true, collect until "done" signal
}) { ... }
```

### 8.4 Config Migration

When loading config, apply defaults for new fields so existing installations keep working:

```javascript
const DEFAULT_CONFIG = {
  // ... existing fields ...
  notifications: {
    idle: true,
    stop: true,
    sessionStart: false,
    sessionEnd: false,
    toolFailure: true,
    subagentStop: false,
    stopWithContinue: false,
  }
};
```

### 8.5 Hook Registration Changes

`registerHook` currently writes a single `PermissionRequest` entry. It needs to:

1. Write entries for each enabled notification hook event
2. Remove entries for disabled notification hook events
3. Preserve entries it doesn't manage (other user hooks)
4. Use the `notify` subcommand for non-interactive hooks

The registration function should accept a config object and derive the full hook set.

---

## 9. CLI UX Changes

### 10.1 Setup Flow

The `setup` command should add a step asking which notifications to enable:

```
? Which notifications would you like to receive?
  [x] Claude is idle (waiting for input)
  [x] Claude finished responding
  [ ] Session started
  [ ] Session ended
  [x] Tool failures
  [ ] Subagent completed

? Enable "Continue" button on finish notifications? (y/N)
```

Since this is a CLI tool without interactive prompts currently (setup uses stdin for config only), this could alternatively be handled via:
- `claude-remote-approver setup --notifications idle,stop,toolFailure`
- Or a separate `claude-remote-approver config` command

### 10.2 Status Command

Extend `status` to show enabled notifications:

```
Topic: cra-a1b2c3d4...
Server: https://ntfy.example.com
Auth: tk_AgQd...Iz2 (configured)
Timeout: 120s / 300s (plan)
Notifications:
  ✓ Idle prompt
  ✓ Stop (finished)
  ✗ Session start
  ✗ Session end
  ✓ Tool failure
  ✗ Subagent stop
```

### 10.3 Enable/Disable Granularity

Consider adding:
- `claude-remote-approver enable notifications` — enable all notification hooks
- `claude-remote-approver disable notifications` — disable all notification hooks
- `claude-remote-approver enable idle` — enable a specific notification type

Or keep it simple and only support `enable`/`disable` for the entire tool (current behavior), with per-notification config via `setup` or config file editing.

---

## 10. Testing Strategy

### 10.1 New Test Files

- `test/notify.test.mjs` — processNotify() unit tests for each notification type, config filtering, formatting
- Extend `test/hook.test.mjs` — multi-select accumulation, multi-question sequences, "Use CLI" button handling
- Extend `test/ntfy.test.mjs` — priority/tags/markdown parameters in sendNotification
- Extend `test/setup.test.mjs` — multi-hook registration/unregistration
- Extend `test/cli.test.mjs` — `notify` command routing

### 10.2 Test Patterns

Follow existing patterns:
- Mock `deps` objects with `t.mock.fn()`
- `createMockFetch()` / `createSSEStream()` for HTTP/SSE mocking
- No external dependencies for testing

### 10.3 Multi-Select SSE Testing

Need a new helper that emits multiple SSE events before closing:

```javascript
function createMultiEventSSEStream(events) {
  // Emits events with delays between them
  // Allows testing accumulation behavior
}
```

---

## 11. Rollout Plan

### Phase 1: Auth Token Support + System Prompt
- Add `authToken` to config schema with backward-compatible defaults
- Thread auth through `sendNotification()`, `waitForResponse()`, `buildActions()`, `buildQuestionActions()`
- Update `setup` flow with auth prompts and validation round-trip
- Document recommended server-side ACL setup
- Add `context` command and `SessionStart` hook for system prompt injection
- Add `prompt` command for printable CLAUDE.md snippet
- Ship as v0.7.0

### Phase 2: Non-Interactive Notifications
- Add `notify` command and `processNotify()`
- Add `formatNotification()` with priority/tags
- Extend `sendNotification()` with priority/tags/markdown
- Extend config schema with `notifications` settings
- Extend `setup` to register notification hooks
- Ship as v0.8.0

### Phase 3: Question Flow Improvements
- "Use CLI" fallback button on all question notifications
- Multi-question sequence support (process all questions, not just first)
- Markdown rendering for question content
- Ship as v0.9.0

### Phase 4: Multi-Select & Continue
- Multi-select answer accumulation in `waitForResponse()`
- Confirmation notifications showing current selections
- "Continue" button on Stop notifications
- Ship as v0.10.0

---

## 12. Constraints & Risks

| Constraint | Impact | Mitigation |
|---|---|---|
| 3 buttons max per ntfy notification | Limits options per screen; "Use CLI" costs 1 button slot | Batching (existing), prioritize most common options first |
| No text input in ntfy.sh actions | Cannot support "Other" free-text answers remotely | "Use CLI" fallback button returns to interactive prompt |
| 4,096 byte message limit | Long plan text or error messages truncated | Already mitigated by 1000-char truncation |
| Auth token embedded in action payloads | Token visible in ntfy message cache (12h default) | Acceptable: topic name is already a 128-bit secret; recommend dedicated ntfy user with scoped ACLs |
| ntfy tokens are user-scoped, not topic-scoped | Token grants access to all topics the user can access | Create dedicated ntfy user with ACL limited to `cra-*` topics |
| SSE connection per hook invocation | Multi-select requires longer-lived SSE connections | Bounded by existing timeout mechanism |
| `PermissionRequest` hook doesn't fire with `-p` flag | Non-interactive Claude Code sessions get no remote approval | Document limitation; suggest `PreToolUse` hook for CI/CD |
| Multi-select toggle UX is awkward over push notifications | Users may not understand toggle-on/toggle-off via re-tapping | Send confirmation notification after each tap showing current state |
| 250 messages/day on free ntfy.sh tier | Notification-heavy sessions could hit limits | Self-hosted (primary target) has no rate limits by default |

---

## 13. Feature 4: Claude Code System Prompt for Remote Awareness

### 13.1 Problem

Claude Code has no awareness that permissions and questions are being routed to a remote user's phone. This leads to suboptimal behavior:

- Claude may ask `AskUserQuestion` with many options or long preview content that doesn't render well on a phone screen
- Claude doesn't know about the 3-button-per-notification limit and may structure questions in ways that fragment badly across batches
- Claude doesn't know that "Other" (free-text) answers require the user to walk to their terminal
- Claude doesn't know that responses may have higher latency than a local CLI prompt

### 13.2 Approach: Generated CLAUDE.md Snippet

The `setup` command (or a new `claude-remote-approver prompt` command) could output a CLAUDE.md snippet that users add to their project or global Claude Code config. This snippet would be injected into Claude's system context and teach it how to interact with the remote approver effectively.

### 13.3 Proposed System Prompt Content

```markdown
## Remote Approval Context

Permission requests and questions in this session are delivered to the user's phone
via push notifications (ntfy.sh). Keep these constraints in mind:

### Permission Requests
- The user sees a notification with Approve/Deny buttons on their phone
- Keep tool descriptions concise — messages are truncated at 1000 characters
- Batch related file operations when possible to reduce notification volume

### Questions (AskUserQuestion)
- Each notification supports a maximum of 3 action buttons
- Questions with >3 options are split across multiple notifications — prefer ≤3 options when possible
- The user cannot type free-text responses remotely; "Other" requires them to use the CLI
- Keep option labels short (they become button text on a phone screen)
- Prefer 2-3 clear options over many granular ones
- If you need detailed input, prefer asking a simple question first, then following up
- Option descriptions are shown in the notification body — keep them to one line each

### General
- Responses may have higher latency than a local terminal (the user may not see
  the notification immediately)
- Minimize the total number of permission prompts and questions per task
- When a task can proceed with reasonable defaults, prefer that over asking
```

### 13.4 Delivery Mechanism Options

**Option A: Auto-generate into project CLAUDE.md**
- `claude-remote-approver setup` appends the snippet to `.claude/CLAUDE.md` (project-level)
- Pro: automatic, no user action needed
- Con: pollutes project config; different projects may not want it

**Option B: CLI command outputs snippet to stdout**
- `claude-remote-approver prompt` prints the snippet
- User copies it into their preferred location (`~/.claude/CLAUDE.md`, project CLAUDE.md, etc.)
- Pro: user controls placement; clean separation of concerns
- Con: manual step

**Option C: SessionStart hook injects context**
- Register a `SessionStart` hook that returns the prompt as `additionalContext`
- Claude Code supports this: `SessionStart` hook output is injected into Claude's context
- Pro: fully automatic, no file changes, works globally
- Con: adds to every session's context window; context is ephemeral (not visible in CLAUDE.md)

**Recommendation: Option C as primary, Option B as supplement.** The `SessionStart` hook injection is invisible and automatic. The CLI command provides a printable version for users who want to customize it or include it in project CLAUDE.md.

### 13.5 SessionStart Hook Implementation

Register a `SessionStart` hook during setup:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "claude-remote-approver context"
          }
        ]
      }
    ]
  }
}
```

The `context` command:
1. Loads config
2. Outputs JSON to stdout with the system prompt as `additionalContext`:

```json
{
  "hookSpecificOutput": {
    "additionalContext": "Permission requests and questions are delivered to the user's phone via push notifications..."
  }
}
```

Claude Code injects this into the conversation context at session start. No user interaction needed.

### 13.6 Dynamic Context

The prompt content could be dynamic based on config:
- If `notifications.stop` is enabled, mention that the user will be notified when Claude finishes
- If multi-select is supported, mention toggle behavior
- If `stopWithContinue` is enabled, mention the user can remotely request continuation
- Include the configured timeout values so Claude knows how long the user has to respond

---

## 14. Questions and answers

1. **Should `Stop` hook "Continue" feature use a short timeout (15-30s) or the full timeout (120s)?** Short timeout avoids blocking Claude but may not give the user enough time to see the notification and decide. A dedicated `continueTimeout` config value may be warranted.

Answer: Let's default to full timeout and add the suggested config value

2. **Should notification hooks be registered as `async: true` in settings.json?** Claude Code supports async hooks (fire-and-forget from Claude's perspective). This would prevent any latency impact on Claude even if ntfy.sh is slow. Downside: async hooks cannot return output to Claude.

Answer: For notifications that don't need a response I don't see a downside, but otherwise I don't know how much this helps.

3. **Multi-question flow: sequential notifications or single combined notification?** Sequential gives each question full screen space but requires multiple interactions. Combined fits in one notification but is cramped for >2 questions. Recommendation: sequential, matching the interactive CLI experience.

Answer: Sequential

4. **Should we support the `Notification` hook's `elicitation_dialog` matcher?** This fires when an elicitation dialog appears, which is similar to `AskUserQuestion`. It may be redundant with the existing `PermissionRequest`-based interception. Needs testing.

Answer: let's implement it and test

5. **Icon URL**: Should we host a Claude/Anthropic icon somewhere for use in `icon` field? Or leave it to the user to configure?

Answer: Leave to the user

6. **Config command**: Should there be a dedicated `claude-remote-approver config` interactive command for toggling notification types, or is config file editing + `setup` re-run sufficient?

Answer: config command would be useful, but configfile editing + setup should also work when used.

7. **System prompt scope**: Should the `SessionStart` context injection be global (all sessions) or configurable per-project? Global is simpler but adds context overhead to sessions where remote approval isn't needed.

Answer: Configurable

8. **Auth token rotation**: Should the tool support token rotation without full re-setup? A `claude-remote-approver set-token <tk_...>` command could update the config and re-validate without regenerating the topic.

Answer: No

9. **HTTP vs HTTPS enforcement**: Should setup refuse `http://` servers entirely (except localhost), or just warn? Sending Bearer tokens over plaintext HTTP is a real security risk for non-local servers.

Answer: Refuse with the ability to override in config