# Expanded Notification & Interaction Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add self-hosted ntfy auth token support, fire-and-forget notification hooks, system prompt injection, and improved question flows to claude-remote-approver.

**Architecture:** Extend the existing dependency-injection architecture with new modules (`src/notify.mjs`, `src/context.mjs`) for notification and context handling. Thread an optional `authToken` through all HTTP call sites. Add a `notifications` config object for per-type enable/disable. All new features maintain the fallback-to-CLI guarantee.

**Tech Stack:** Node.js 18+, pure ESM, zero dev dependencies, `node:test` + `node:assert/strict` for testing.

---

## Phase 1: Auth Token Support (v0.7.0)

### Task 1: Extend config schema with `authToken` and `notifications`

**Files:**
- Modify: `src/config.mjs:8-16` (DEFAULT_CONFIG)
- Test: `test/config.test.mjs`

**Step 1: Write the failing tests**

Add to `test/config.test.mjs` in the `DEFAULT_CONFIG` describe block:

```javascript
it("should have authToken as empty string", () => {
  assert.equal(DEFAULT_CONFIG.authToken, "");
});

it("should have notifications as an object with correct defaults", () => {
  assert.equal(typeof DEFAULT_CONFIG.notifications, "object");
  assert.equal(DEFAULT_CONFIG.notifications.idle, true);
  assert.equal(DEFAULT_CONFIG.notifications.stop, true);
  assert.equal(DEFAULT_CONFIG.notifications.sessionStart, false);
  assert.equal(DEFAULT_CONFIG.notifications.sessionEnd, false);
  assert.equal(DEFAULT_CONFIG.notifications.toolFailure, true);
  assert.equal(DEFAULT_CONFIG.notifications.subagentStop, false);
  assert.equal(DEFAULT_CONFIG.notifications.stopWithContinue, false);
});
```

Add to `test/config.test.mjs` in the `loadConfig` describe block:

```javascript
it("should fall back to default authToken when authToken is not a string", () => {
  fs.writeFileSync(tmpConfigPath, JSON.stringify({ authToken: 123 }));
  const config = loadConfig(tmpConfigPath);
  assert.equal(config.authToken, DEFAULT_CONFIG.authToken);
});

it("should accept valid authToken from config file", () => {
  fs.writeFileSync(tmpConfigPath, JSON.stringify({ authToken: "tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2" }));
  const config = loadConfig(tmpConfigPath);
  assert.equal(config.authToken, "tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2");
});

it("should fall back to default notifications when notifications is not an object", () => {
  fs.writeFileSync(tmpConfigPath, JSON.stringify({ notifications: "all" }));
  const config = loadConfig(tmpConfigPath);
  assert.deepEqual(config.notifications, DEFAULT_CONFIG.notifications);
});

it("should merge partial notifications with defaults", () => {
  fs.writeFileSync(tmpConfigPath, JSON.stringify({ notifications: { idle: false, sessionStart: true } }));
  const config = loadConfig(tmpConfigPath);
  assert.equal(config.notifications.idle, false);
  assert.equal(config.notifications.sessionStart, true);
  assert.equal(config.notifications.stop, true); // default preserved
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `authToken` and `notifications` not in DEFAULT_CONFIG

**Step 3: Implement config changes**

In `src/config.mjs`, update `DEFAULT_CONFIG`:

```javascript
export const DEFAULT_CONFIG = {
  topic: "",
  ntfyServer: "https://ntfy.sh",
  authToken: "",
  timeout: 120,
  planTimeout: 300,
  autoApprove: [],
  autoDeny: [],
  notifications: {
    idle: true,
    stop: true,
    sessionStart: false,
    sessionEnd: false,
    toolFailure: true,
    subagentStop: false,
    stopWithContinue: false,
  },
};
```

In `loadConfig`, add validation after the existing checks:

```javascript
if (typeof config.authToken !== "string") config.authToken = DEFAULT_CONFIG.authToken;
if (typeof config.notifications !== "object" || config.notifications === null || Array.isArray(config.notifications)) {
  config.notifications = { ...DEFAULT_CONFIG.notifications };
} else {
  config.notifications = { ...DEFAULT_CONFIG.notifications, ...config.notifications };
}
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/config.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config.mjs test/config.test.mjs
git commit -m "feat: add authToken and notifications to config schema"
```

---

### Task 2: Thread `authToken` through `sendNotification`

**Files:**
- Modify: `src/ntfy.mjs:9-24` (sendNotification)
- Test: `test/ntfy.test.mjs`

**Step 1: Write the failing tests**

Add to `test/ntfy.test.mjs` in the `sendNotification` describe block:

```javascript
it("should include Authorization header when authToken is provided", async () => {
  const mockFetch = createMockFetch();
  globalThis.fetch = mockFetch;

  await sendNotification({
    server: "https://ntfy.example.com",
    topic: "my-topic",
    title: "Test",
    message: "Hello",
    actions: [],
    requestId: "req-auth-1",
    authToken: "tk_testtoken123",
  });

  const headers = mockFetch.calls[0].options.headers;
  const auth = headers instanceof Headers ? headers.get("Authorization") : headers["Authorization"];
  assert.equal(auth, "Bearer tk_testtoken123");
});

it("should not include Authorization header when authToken is absent", async () => {
  const mockFetch = createMockFetch();
  globalThis.fetch = mockFetch;

  await sendNotification({
    server: "https://ntfy.sh",
    topic: "my-topic",
    title: "Test",
    message: "Hello",
    actions: [],
    requestId: "req-auth-2",
  });

  const headers = mockFetch.calls[0].options.headers;
  const auth = headers instanceof Headers ? headers.get("Authorization") : headers["Authorization"];
  assert.equal(auth, undefined);
});

it("should not include Authorization header when authToken is empty string", async () => {
  const mockFetch = createMockFetch();
  globalThis.fetch = mockFetch;

  await sendNotification({
    server: "https://ntfy.sh",
    topic: "my-topic",
    title: "Test",
    message: "Hello",
    actions: [],
    requestId: "req-auth-3",
    authToken: "",
  });

  const headers = mockFetch.calls[0].options.headers;
  const auth = headers instanceof Headers ? headers.get("Authorization") : headers["Authorization"];
  assert.equal(auth, undefined);
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/ntfy.test.mjs`
Expected: FAIL — Authorization header not set

**Step 3: Implement auth in sendNotification**

Update `sendNotification` signature and body in `src/ntfy.mjs`:

```javascript
export async function sendNotification({ server, topic, title, message, actions, requestId, authToken, priority, tags, markdown }) {
  const baseUrl = server.replace(/\/+$/, '');
  const url = baseUrl;

  const headers = { 'Content-Type': 'application/json' };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const body = { topic, title, message, actions };
  if (priority) body.priority = priority;
  if (tags) body.tags = tags;
  if (markdown) body.markdown = true;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`ntfy notification failed: HTTP ${response.status}`);
  }

  return response;
}
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/ntfy.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add src/ntfy.mjs test/ntfy.test.mjs
git commit -m "feat: add authToken, priority, tags, markdown to sendNotification"
```

---

### Task 3: Thread `authToken` through `waitForResponse`

**Files:**
- Modify: `src/ntfy.mjs:32-97` (waitForResponse)
- Test: `test/ntfy.test.mjs`

**Step 1: Write the failing tests**

Add to `test/ntfy.test.mjs` in the `waitForResponse` describe block:

```javascript
it("should include Authorization header when authToken is provided", async () => {
  let capturedOptions;
  const mockFetch = mock.fn(async (url, options) => {
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      body: createSSEStream([
        { event: "message", message: JSON.stringify({ requestId: "req-auth-wr", approved: true }) },
      ]),
    };
  });
  globalThis.fetch = mockFetch;

  await waitForResponse({
    server: "https://ntfy.example.com",
    topic: "my-topic",
    requestId: "req-auth-wr",
    timeout: 5000,
    authToken: "tk_testtoken123",
  });

  assert.ok(capturedOptions.headers, "fetch should have headers");
  assert.equal(capturedOptions.headers["Authorization"], "Bearer tk_testtoken123");
});

it("should not include Authorization header when authToken is absent", async () => {
  let capturedOptions;
  const mockFetch = mock.fn(async (url, options) => {
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      body: createSSEStream([
        { event: "message", message: JSON.stringify({ requestId: "req-noauth-wr", approved: true }) },
      ]),
    };
  });
  globalThis.fetch = mockFetch;

  await waitForResponse({
    server: "https://ntfy.sh",
    topic: "my-topic",
    requestId: "req-noauth-wr",
    timeout: 5000,
  });

  assert.equal(capturedOptions.headers, undefined);
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/ntfy.test.mjs`
Expected: FAIL

**Step 3: Implement auth in waitForResponse**

Update `waitForResponse` in `src/ntfy.mjs` to accept and use `authToken`:

```javascript
export async function waitForResponse({ server, topic, requestId, timeout, authToken }) {
  const baseUrl = server.replace(/\/+$/, '');
  const url = `${baseUrl}/${topic}-response/json`;

  const controller = new AbortController();
  const fetchOptions = { signal: controller.signal };
  if (authToken) {
    fetchOptions.headers = { 'Authorization': `Bearer ${authToken}` };
  }

  let timer;

  try {
    const response = await fetch(url, fetchOptions);
    // ... rest of the function unchanged ...
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/ntfy.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add src/ntfy.mjs test/ntfy.test.mjs
git commit -m "feat: add authToken to waitForResponse SSE subscription"
```

---

### Task 4: Thread `authToken` through action buttons (`buildActions` and `buildQuestionActions`)

**Files:**
- Modify: `src/hook.mjs:23-51` (buildActions) and `src/hook.mjs:86-95` (buildQuestionActions)
- Test: `test/hook.test.mjs`

**Step 1: Write the failing tests**

Add to `test/hook.test.mjs` in the `buildActions` describe block:

```javascript
it("should include Authorization header in action definitions when authToken is provided", () => {
  const actions = buildActions("https://ntfy.example.com", "my-topic", "req-auth", { authToken: "tk_test123" });

  for (const action of actions) {
    assert.deepEqual(action.headers, { Authorization: "Bearer tk_test123" });
  }
});

it("should not include headers in action definitions when authToken is absent", () => {
  const actions = buildActions("https://ntfy.sh", "my-topic", "req-noauth");

  for (const action of actions) {
    assert.equal(action.headers, undefined);
  }
});

it("should include Authorization header in Always Approve action when authToken is provided", () => {
  const actions = buildActions("https://ntfy.example.com", "my-topic", "req-aa-auth", {
    permissionSuggestions: ["Bash(*)"],
    authToken: "tk_test123",
  });

  assert.equal(actions.length, 3);
  for (const action of actions) {
    assert.deepEqual(action.headers, { Authorization: "Bearer tk_test123" });
  }
});
```

Add to `test/hook.test.mjs` — add a new `buildQuestionActions` describe block or extend the existing one:

```javascript
it("should include Authorization header in question action definitions when authToken is provided", () => {
  const options = [{ label: "Option A", description: "First" }];
  const actions = buildQuestionActions("https://ntfy.example.com", "my-topic", "req-q-auth", options, { authToken: "tk_test123" });

  for (const action of actions) {
    assert.deepEqual(action.headers, { Authorization: "Bearer tk_test123" });
  }
});

it("should not include headers in question action definitions when authToken is absent", () => {
  const options = [{ label: "Option A", description: "First" }];
  const actions = buildQuestionActions("https://ntfy.sh", "my-topic", "req-q-noauth", options);

  for (const action of actions) {
    assert.equal(action.headers, undefined);
  }
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/hook.test.mjs`
Expected: FAIL

**Step 3: Implement auth in buildActions and buildQuestionActions**

Update `buildActions` in `src/hook.mjs`:

```javascript
export function buildActions(server, topic, requestId, { permissionSuggestions, authToken } = {}) {
  const url = `${server}/${topic}-response`;
  const makeAction = (label, body) => {
    const action = {
      action: "http",
      label,
      url,
      body: JSON.stringify(body),
      method: "POST",
    };
    if (authToken) {
      action.headers = { Authorization: `Bearer ${authToken}` };
    }
    return action;
  };

  const actions = [
    makeAction("Approve", { requestId, approved: true }),
    makeAction("Deny", { requestId, approved: false }),
  ];
  if (permissionSuggestions?.length > 0) {
    actions.splice(1, 0, makeAction("Always Approve", { requestId, approved: true, alwaysAllow: true }));
  }
  return actions;
}
```

Update `buildQuestionActions` in `src/hook.mjs` to accept options object:

```javascript
export function buildQuestionActions(server, topic, requestId, options, { authToken } = {}) {
  const url = `${server}/${topic}-response`;
  return options.map((opt) => {
    const action = {
      action: "http",
      label: opt.label,
      url,
      body: JSON.stringify({ requestId, answer: opt.label }),
      method: "POST",
    };
    if (authToken) {
      action.headers = { Authorization: `Bearer ${authToken}` };
    }
    return action;
  });
}
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/hook.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add src/hook.mjs test/hook.test.mjs
git commit -m "feat: add authToken to action button definitions for self-hosted ntfy auth"
```

---

### Task 5: Thread `authToken` through `processHook` and `processAskUserQuestion`

**Files:**
- Modify: `src/hook.mjs:115-252` (processAskUserQuestion and processHook)
- Test: `test/hook.test.mjs`

**Step 1: Write the failing tests**

Add to `test/hook.test.mjs` in the `processHook` describe block:

```javascript
it("should pass authToken to sendNotification, waitForResponse, and buildActions", async () => {
  const sendCalls = [];
  const waitCalls = [];
  const result = await processHook(
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
    {
      loadConfig: () => ({
        topic: "my-topic",
        ntfyServer: "https://ntfy.example.com",
        timeout: 120,
        planTimeout: 300,
        authToken: "tk_test123",
      }),
      sendNotification: async (params) => {
        sendCalls.push(params);
        return { ok: true };
      },
      waitForResponse: async (params) => {
        waitCalls.push(params);
        return { approved: true };
      },
      formatToolInfo: () => ({ title: "Test", message: "test" }),
    },
  );

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].authToken, "tk_test123");
  assert.equal(waitCalls.length, 1);
  assert.equal(waitCalls[0].authToken, "tk_test123");

  // Check action buttons include auth header
  const actions = sendCalls[0].actions;
  for (const action of actions) {
    assert.deepEqual(action.headers, { Authorization: "Bearer tk_test123" });
  }
});
```

Add a similar test for `processAskUserQuestion`:

```javascript
it("should pass authToken through AskUserQuestion flow", async () => {
  const sendCalls = [];
  const waitCalls = [];
  const input = {
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [{
        question: "Which option?",
        header: "Choice",
        options: [{ label: "A", description: "First" }],
        multiSelect: false,
      }],
    },
  };

  await processAskUserQuestion(input, {
    loadConfig: () => ({
      topic: "my-topic",
      ntfyServer: "https://ntfy.example.com",
      timeout: 120,
      authToken: "tk_test123",
    }),
    sendNotification: async (params) => {
      sendCalls.push(params);
      return { ok: true };
    },
    waitForResponse: async (params) => {
      waitCalls.push(params);
      return { answer: "A" };
    },
  });

  assert.equal(sendCalls[0].authToken, "tk_test123");
  assert.equal(waitCalls[0].authToken, "tk_test123");
  // Check action buttons include auth header
  for (const action of sendCalls[0].actions) {
    assert.deepEqual(action.headers, { Authorization: "Bearer tk_test123" });
  }
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/hook.test.mjs`
Expected: FAIL

**Step 3: Implement auth threading in processHook and processAskUserQuestion**

In `processHook`, after loading config, thread `config.authToken`:

```javascript
export async function processHook(input, { loadConfig, sendNotification, waitForResponse, formatToolInfo }) {
  const config = loadConfig();
  if (!config.topic) return ASK;

  if (isAskUserQuestion(input)) {
    return processAskUserQuestion(input, { loadConfig, sendNotification, waitForResponse });
  }

  const requestId = crypto.randomUUID();
  const { title, message } = formatToolInfo(input);
  const actions = buildActions(config.ntfyServer, config.topic, requestId, {
    permissionSuggestions: input.permission_suggestions,
    authToken: config.authToken,
  });

  const sent = await sendWithRetry(sendNotification, {
    server: config.ntfyServer,
    topic: config.topic,
    title,
    message,
    actions,
    requestId,
    authToken: config.authToken,
  });
  if (!sent) return ASK;

  let response;
  try {
    const isPlanReview = input.tool_name === "ExitPlanMode";
    const timeout = (isPlanReview ? (config.planTimeout ?? DEFAULT_CONFIG.planTimeout) : config.timeout) * 1000;
    response = await waitForResponse({
      server: config.ntfyServer,
      topic: config.topic,
      requestId,
      timeout,
      authToken: config.authToken,
    });
  } catch (err) {
    // ... unchanged
  }
  // ... rest unchanged
}
```

Similarly update `processAskUserQuestion` to read `config.authToken` and pass it to `sendNotification`, `waitForResponse`, and `buildQuestionActions`.

**Step 4: Run tests to verify they pass**

Run: `node --test test/hook.test.mjs`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/hook.mjs test/hook.test.mjs
git commit -m "feat: thread authToken through processHook and processAskUserQuestion"
```

---

### Task 6: Add `sendNotification` support for `priority`, `tags`, `markdown`

**Files:**
- Modify: `src/ntfy.mjs` (already partially done in Task 2)
- Test: `test/ntfy.test.mjs`

**Step 1: Write the failing tests**

Add to `test/ntfy.test.mjs` in the `sendNotification` describe block:

```javascript
it("should include priority in JSON body when provided", async () => {
  const mockFetch = createMockFetch();
  globalThis.fetch = mockFetch;

  await sendNotification({
    server: "https://ntfy.sh",
    topic: "my-topic",
    title: "Test",
    message: "Hello",
    actions: [],
    requestId: "req-pri",
    priority: 4,
  });

  const body = JSON.parse(mockFetch.calls[0].options.body);
  assert.equal(body.priority, 4);
});

it("should include tags in JSON body when provided", async () => {
  const mockFetch = createMockFetch();
  globalThis.fetch = mockFetch;

  await sendNotification({
    server: "https://ntfy.sh",
    topic: "my-topic",
    title: "Test",
    message: "Hello",
    actions: [],
    requestId: "req-tags",
    tags: ["warning", "computer"],
  });

  const body = JSON.parse(mockFetch.calls[0].options.body);
  assert.deepEqual(body.tags, ["warning", "computer"]);
});

it("should include markdown: true in JSON body when provided", async () => {
  const mockFetch = createMockFetch();
  globalThis.fetch = mockFetch;

  await sendNotification({
    server: "https://ntfy.sh",
    topic: "my-topic",
    title: "Test",
    message: "**bold** message",
    actions: [],
    requestId: "req-md",
    markdown: true,
  });

  const body = JSON.parse(mockFetch.calls[0].options.body);
  assert.equal(body.markdown, true);
});

it("should not include priority, tags, or markdown when not provided", async () => {
  const mockFetch = createMockFetch();
  globalThis.fetch = mockFetch;

  await sendNotification({
    server: "https://ntfy.sh",
    topic: "my-topic",
    title: "Test",
    message: "Hello",
    actions: [],
    requestId: "req-plain",
  });

  const body = JSON.parse(mockFetch.calls[0].options.body);
  assert.equal(body.priority, undefined);
  assert.equal(body.tags, undefined);
  assert.equal(body.markdown, undefined);
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/ntfy.test.mjs`
Expected: FAIL (unless Task 2 already added these — verify)

**Step 3: Ensure implementation handles all fields**

If not already done in Task 2, the `sendNotification` function should destructure `priority`, `tags`, `markdown` and add them to the body conditionally. (This was included in the Task 2 implementation.)

**Step 4: Run tests to verify they pass**

Run: `node --test test/ntfy.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add src/ntfy.mjs test/ntfy.test.mjs
git commit -m "feat: add priority, tags, markdown support to sendNotification"
```

---

## Phase 2: Non-Interactive Notifications (v0.8.0)

### Task 7: Create `src/notify.mjs` with `processNotify`

**Files:**
- Create: `src/notify.mjs`
- Create: `test/notify.test.mjs`

**Step 1: Write the failing tests**

Create `test/notify.test.mjs`:

```javascript
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { processNotify, formatNotification } from "../src/notify.mjs";

describe("formatNotification", () => {
  it("should format Notification/idle_prompt event", () => {
    const result = formatNotification({
      hook_event_name: "Notification",
      notification: { title: "Claude Code", body: "Waiting for input" },
    });
    assert.equal(typeof result.title, "string");
    assert.equal(typeof result.message, "string");
    assert.equal(result.priority, 4);
    assert.deepEqual(result.tags, ["hourglass_flowing_sand"]);
  });

  it("should format Stop event", () => {
    const result = formatNotification({
      hook_event_name: "Stop",
      stop_hook_active: true,
    });
    assert.ok(result.message.toLowerCase().includes("finished"));
    assert.equal(result.priority, 3);
    assert.deepEqual(result.tags, ["white_check_mark"]);
  });

  it("should format PostToolUseFailure event", () => {
    const result = formatNotification({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      error: "Command failed with exit code 1",
    });
    assert.ok(result.title.includes("Bash"));
    assert.ok(result.message.includes("Command failed"));
    assert.equal(result.priority, 4);
    assert.deepEqual(result.tags, ["warning", "x"]);
  });

  it("should format SessionStart event", () => {
    const result = formatNotification({ hook_event_name: "SessionStart" });
    assert.ok(result.message.toLowerCase().includes("session started"));
    assert.equal(result.priority, 2);
    assert.deepEqual(result.tags, ["rocket"]);
  });

  it("should format SessionEnd event", () => {
    const result = formatNotification({ hook_event_name: "SessionEnd" });
    assert.ok(result.message.toLowerCase().includes("session ended"));
    assert.equal(result.priority, 2);
    assert.deepEqual(result.tags, ["stop_sign"]);
  });

  it("should format SubagentStop event", () => {
    const result = formatNotification({ hook_event_name: "SubagentStop" });
    assert.ok(result.message.toLowerCase().includes("subagent"));
    assert.equal(result.priority, 2);
    assert.deepEqual(result.tags, ["robot_face"]);
  });

  it("should truncate error messages to 1000 chars", () => {
    const result = formatNotification({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      error: "x".repeat(1500),
    });
    assert.ok(result.message.length <= 1003);
  });

  it("should return null for unknown event types", () => {
    const result = formatNotification({ hook_event_name: "UnknownEvent" });
    assert.equal(result, null);
  });
});

describe("processNotify", () => {
  it("should send notification when event type is enabled in config", async () => {
    const sendCalls = [];
    await processNotify(
      { hook_event_name: "Stop" },
      {
        loadConfig: () => ({
          topic: "my-topic",
          ntfyServer: "https://ntfy.sh",
          authToken: "",
          notifications: { stop: true },
        }),
        sendNotification: async (params) => {
          sendCalls.push(params);
          return { ok: true };
        },
      },
    );

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].topic, "my-topic");
    assert.equal(sendCalls[0].priority, 3);
  });

  it("should not send notification when event type is disabled in config", async () => {
    const sendCalls = [];
    await processNotify(
      { hook_event_name: "Stop" },
      {
        loadConfig: () => ({
          topic: "my-topic",
          ntfyServer: "https://ntfy.sh",
          authToken: "",
          notifications: { stop: false },
        }),
        sendNotification: async (params) => {
          sendCalls.push(params);
          return { ok: true };
        },
      },
    );

    assert.equal(sendCalls.length, 0);
  });

  it("should not send notification when no topic is configured", async () => {
    const sendCalls = [];
    await processNotify(
      { hook_event_name: "Stop" },
      {
        loadConfig: () => ({
          topic: "",
          ntfyServer: "https://ntfy.sh",
          notifications: { stop: true },
        }),
        sendNotification: async (params) => {
          sendCalls.push(params);
          return { ok: true };
        },
      },
    );

    assert.equal(sendCalls.length, 0);
  });

  it("should include authToken in sendNotification when configured", async () => {
    const sendCalls = [];
    await processNotify(
      { hook_event_name: "Stop" },
      {
        loadConfig: () => ({
          topic: "my-topic",
          ntfyServer: "https://ntfy.example.com",
          authToken: "tk_test123",
          notifications: { stop: true },
        }),
        sendNotification: async (params) => {
          sendCalls.push(params);
          return { ok: true };
        },
      },
    );

    assert.equal(sendCalls[0].authToken, "tk_test123");
  });

  it("should not throw on sendNotification failure", async () => {
    await assert.doesNotReject(async () => {
      await processNotify(
        { hook_event_name: "Stop" },
        {
          loadConfig: () => ({
            topic: "my-topic",
            ntfyServer: "https://ntfy.sh",
            authToken: "",
            notifications: { stop: true },
          }),
          sendNotification: async () => {
            throw new Error("network error");
          },
        },
      );
    });
  });

  it("should map Notification event to idle config key", async () => {
    const sendCalls = [];
    await processNotify(
      { hook_event_name: "Notification", notification: { title: "t", body: "b" } },
      {
        loadConfig: () => ({
          topic: "my-topic",
          ntfyServer: "https://ntfy.sh",
          authToken: "",
          notifications: { idle: true },
        }),
        sendNotification: async (params) => {
          sendCalls.push(params);
          return { ok: true };
        },
      },
    );

    assert.equal(sendCalls.length, 1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/notify.test.mjs`
Expected: FAIL — module does not exist

**Step 3: Implement `src/notify.mjs`**

```javascript
// src/notify.mjs

const MESSAGE_MAX_LENGTH = 1000;

const EVENT_CONFIG_MAP = {
  Notification: "idle",
  Stop: "stop",
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  PostToolUseFailure: "toolFailure",
  SubagentStop: "subagentStop",
};

export function formatNotification(input) {
  switch (input.hook_event_name) {
    case "Notification":
      return {
        title: input.notification?.title || "Claude Code",
        message: input.notification?.body || "Waiting for input",
        priority: 4,
        tags: ["hourglass_flowing_sand"],
      };
    case "Stop":
      return {
        title: "Claude Code",
        message: "Claude has finished responding",
        priority: 3,
        tags: ["white_check_mark"],
      };
    case "PostToolUseFailure": {
      let msg = input.error || "Unknown error";
      if (msg.length > MESSAGE_MAX_LENGTH) {
        msg = msg.slice(0, MESSAGE_MAX_LENGTH) + "...";
      }
      return {
        title: `Tool Failed: ${input.tool_name || "Unknown"}`,
        message: msg,
        priority: 4,
        tags: ["warning", "x"],
      };
    }
    case "SessionStart":
      return {
        title: "Claude Code",
        message: "Session started",
        priority: 2,
        tags: ["rocket"],
      };
    case "SessionEnd":
      return {
        title: "Claude Code",
        message: "Session ended",
        priority: 2,
        tags: ["stop_sign"],
      };
    case "SubagentStop":
      return {
        title: "Claude Code",
        message: "Subagent finished",
        priority: 2,
        tags: ["robot_face"],
      };
    default:
      return null;
  }
}

export async function processNotify(input, deps) {
  const config = deps.loadConfig();
  if (!config.topic) return;

  const configKey = EVENT_CONFIG_MAP[input.hook_event_name];
  if (!configKey || !config.notifications?.[configKey]) return;

  const notification = formatNotification(input);
  if (!notification) return;

  try {
    await deps.sendNotification({
      server: config.ntfyServer,
      topic: config.topic,
      title: notification.title,
      message: notification.message,
      actions: [],
      requestId: "notify",
      authToken: config.authToken,
      priority: notification.priority,
      tags: notification.tags,
    });
  } catch (err) {
    console.error("[claude-remote-approver] Notification send failed:", err.message);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/notify.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add src/notify.mjs test/notify.test.mjs
git commit -m "feat: add processNotify and formatNotification for fire-and-forget notifications"
```

---

### Task 8: Add `notify` command to CLI

**Files:**
- Modify: `bin/cli.mjs:21-167` (main function)
- Test: `test/cli.test.mjs`

**Step 1: Write the failing tests**

Add to `test/cli.test.mjs`:

```javascript
describe("notify subcommand", () => {
  it("should read JSON from stdin and call processNotify", async () => {
    const notifyInput = { hook_event_name: "Stop" };
    const stdout = createMockWriter();
    const processNotify = mock.fn(async () => {});
    const deps = createDeps({
      stdin: JSON.stringify(notifyInput),
      stdout,
      processNotify,
    });

    await main(["notify"], deps);

    assert.equal(processNotify.mock.callCount(), 1);
    const callArgs = processNotify.mock.calls[0].arguments[0];
    assert.equal(callArgs.hook_event_name, "Stop");
  });

  it("should not write anything to stdout on success", async () => {
    const stdout = createMockWriter();
    const deps = createDeps({
      stdin: JSON.stringify({ hook_event_name: "Stop" }),
      stdout,
      processNotify: mock.fn(async () => {}),
    });

    await main(["notify"], deps);

    assert.equal(stdout.output(), "");
  });

  it("should not crash on malformed JSON stdin", async () => {
    const stderr = createMockWriter();
    const deps = createDeps({
      stdin: "not-json{{{",
      stderr,
      processNotify: mock.fn(async () => {}),
    });

    await assert.doesNotReject(async () => {
      await main(["notify"], deps);
    });
  });

  it("should not crash when processNotify throws", async () => {
    const stderr = createMockWriter();
    const deps = createDeps({
      stdin: JSON.stringify({ hook_event_name: "Stop" }),
      stderr,
      processNotify: mock.fn(async () => {
        throw new Error("notify failed");
      }),
    });

    await assert.doesNotReject(async () => {
      await main(["notify"], deps);
    });
  });
});
```

Also update the help text tests to mention `notify`.

**Step 2: Run tests to verify they fail**

Run: `node --test test/cli.test.mjs`
Expected: FAIL — `notify` not a recognized command

**Step 3: Implement `notify` command in CLI**

Add to the switch statement in `bin/cli.mjs` `main()`:

```javascript
case "notify": {
  let input;
  try {
    input = JSON.parse(deps.stdin);
  } catch {
    deps.stderr.write("[claude-remote-approver] Invalid notify input.\n");
    break;
  }

  try {
    await deps.processNotify(input, deps);
  } catch (err) {
    deps.stderr.write(`[claude-remote-approver] Notify failed: ${err.message}\n`);
  }
  break;
}
```

Add `processNotify` to the imports and deps object in the auto-execute block:

```javascript
const { processNotify } = await import("../src/notify.mjs");
// ... add processNotify to deps object
```

Update the help text to include `notify`.

**Step 4: Run tests to verify they pass**

Run: `node --test test/cli.test.mjs`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add bin/cli.mjs test/cli.test.mjs
git commit -m "feat: add notify CLI command for fire-and-forget notifications"
```

---

### Task 9: Create `src/context.mjs` for SessionStart system prompt injection

**Files:**
- Create: `src/context.mjs`
- Create: `test/context.test.mjs`

**Step 1: Write the failing tests**

Create `test/context.test.mjs`:

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateContext } from "../src/context.mjs";

describe("generateContext", () => {
  it("should return object with hookSpecificOutput.additionalContext", () => {
    const result = generateContext({
      timeout: 120,
      planTimeout: 300,
      notifications: { stop: true, idle: true },
    });
    assert.equal(typeof result, "object");
    assert.equal(typeof result.hookSpecificOutput, "object");
    assert.equal(typeof result.hookSpecificOutput.additionalContext, "string");
  });

  it("should mention 3 action buttons limit", () => {
    const result = generateContext({ timeout: 120, planTimeout: 300, notifications: {} });
    assert.ok(result.hookSpecificOutput.additionalContext.includes("3"));
  });

  it("should mention push notifications", () => {
    const result = generateContext({ timeout: 120, planTimeout: 300, notifications: {} });
    assert.ok(result.hookSpecificOutput.additionalContext.toLowerCase().includes("push notification"));
  });

  it("should include timeout values from config", () => {
    const result = generateContext({ timeout: 60, planTimeout: 600, notifications: {} });
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("60"), "should include timeout value");
    assert.ok(ctx.includes("600"), "should include planTimeout value");
  });

  it("should mention free-text limitation", () => {
    const result = generateContext({ timeout: 120, planTimeout: 300, notifications: {} });
    assert.ok(result.hookSpecificOutput.additionalContext.toLowerCase().includes("free-text") ||
              result.hookSpecificOutput.additionalContext.toLowerCase().includes("cannot type"));
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/context.test.mjs`
Expected: FAIL — module does not exist

**Step 3: Implement `src/context.mjs`**

```javascript
// src/context.mjs

export function generateContext(config) {
  const ctx = `## Remote Approval Context

Permission requests and questions in this session are delivered to the user's phone via push notifications (ntfy). Keep these constraints in mind:

### Permission Requests
- The user sees a notification with Approve/Deny buttons on their phone
- Keep tool descriptions concise — messages are truncated at 1000 characters
- Batch related file operations when possible to reduce notification volume
- Response timeout: ${config.timeout}s (${config.planTimeout}s for plan reviews)

### Questions (AskUserQuestion)
- Each notification supports a maximum of 3 action buttons
- Questions with >3 options are split across multiple notifications — prefer ≤3 options when possible
- The user cannot type free-text responses remotely; "Other" requires them to use the CLI
- Keep option labels short (they become button text on a phone screen)
- Prefer 2-3 clear options over many granular ones
- Option descriptions are shown in the notification body — keep them to one line each

### General
- Responses may have higher latency than a local terminal
- Minimize the total number of permission prompts and questions per task
- When a task can proceed with reasonable defaults, prefer that over asking`;

  return {
    hookSpecificOutput: {
      additionalContext: ctx,
    },
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/context.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add src/context.mjs test/context.test.mjs
git commit -m "feat: add generateContext for SessionStart system prompt injection"
```

---

### Task 10: Add `context` and `prompt` commands to CLI

**Files:**
- Modify: `bin/cli.mjs`
- Test: `test/cli.test.mjs`

**Step 1: Write the failing tests**

Add to `test/cli.test.mjs`:

```javascript
describe("context subcommand", () => {
  it("should output JSON with hookSpecificOutput.additionalContext", async () => {
    const stdout = createMockWriter();
    const deps = createDeps({ stdout });

    await main(["context"], deps);

    const output = stdout.output();
    const parsed = JSON.parse(output);
    assert.equal(typeof parsed.hookSpecificOutput.additionalContext, "string");
  });

  it("should load config for context generation", async () => {
    const deps = createDeps();
    await main(["context"], deps);
    assert.equal(deps.loadConfig.mock.callCount(), 1);
  });
});

describe("prompt subcommand", () => {
  it("should output the system prompt text to stdout", async () => {
    const stdout = createMockWriter();
    const deps = createDeps({ stdout });

    await main(["prompt"], deps);

    const output = stdout.output();
    assert.ok(output.includes("Remote Approval Context"));
    assert.ok(output.includes("push notification"));
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/cli.test.mjs`
Expected: FAIL

**Step 3: Implement `context` and `prompt` commands**

Add to the switch in `main()`:

```javascript
case "context": {
  const config = deps.loadConfig();
  const result = deps.generateContext(config);
  deps.stdout.write(JSON.stringify(result) + "\n");
  break;
}

case "prompt": {
  const config = deps.loadConfig();
  const result = deps.generateContext(config);
  deps.stdout.write(result.hookSpecificOutput.additionalContext + "\n");
  break;
}
```

Add `generateContext` to imports and deps in the auto-execute block.
Update help text to include `context` and `prompt`.

**Step 4: Run tests to verify they pass**

Run: `node --test test/cli.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add bin/cli.mjs test/cli.test.mjs
git commit -m "feat: add context and prompt CLI commands for system prompt injection"
```

---

### Task 11: Extend hook registration for notification hooks

**Files:**
- Modify: `src/setup.mjs`
- Test: `test/setup.test.mjs`

**Step 1: Write the failing tests**

Add to `test/setup.test.mjs`:

```javascript
describe("registerNotificationHooks", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cra-notify-hook-test-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should register Notification hook when idle is enabled", () => {
    const settingsPath = path.join(tmpDir, "notify-idle.json");
    const hookCommand = 'node "/path/to/cli.mjs" notify';
    const notifications = { idle: true, stop: false };

    registerNotificationHooks(settingsPath, hookCommand, notifications);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.ok(Array.isArray(settings.hooks.Notification));
  });

  it("should register Stop hook when stop is enabled", () => {
    const settingsPath = path.join(tmpDir, "notify-stop.json");
    const hookCommand = 'node "/path/to/cli.mjs" notify';
    const notifications = { idle: false, stop: true };

    registerNotificationHooks(settingsPath, hookCommand, notifications);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.ok(Array.isArray(settings.hooks.Stop));
  });

  it("should register SessionStart context hook", () => {
    const settingsPath = path.join(tmpDir, "notify-context.json");
    const contextCommand = 'node "/path/to/cli.mjs" context';
    const notifications = {};

    registerNotificationHooks(settingsPath, 'node "/path/to/cli.mjs" notify', notifications, contextCommand);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.ok(Array.isArray(settings.hooks.SessionStart));
  });

  it("should not register hooks for disabled notification types", () => {
    const settingsPath = path.join(tmpDir, "notify-disabled.json");
    const hookCommand = 'node "/path/to/cli.mjs" notify';
    const notifications = { idle: false, stop: false, sessionStart: false, sessionEnd: false, toolFailure: false, subagentStop: false };

    registerNotificationHooks(settingsPath, hookCommand, notifications);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(settings.hooks?.Notification, undefined);
    assert.equal(settings.hooks?.Stop, undefined);
  });

  it("should preserve existing non-CRA hooks", () => {
    const settingsPath = path.join(tmpDir, "notify-preserve.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo other" }] }],
      },
    }, null, 2));

    const hookCommand = 'node "/path/to/cli.mjs" notify';
    registerNotificationHooks(settingsPath, hookCommand, { stop: true });

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(settings.hooks.Stop.length, 2);
    assert.equal(settings.hooks.Stop[0].hooks[0].command, "echo other");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/setup.test.mjs`
Expected: FAIL — `registerNotificationHooks` not exported

**Step 3: Implement `registerNotificationHooks`**

Add to `src/setup.mjs`:

```javascript
const NOTIFICATION_HOOK_EVENTS = {
  idle: "Notification",
  stop: "Stop",
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  toolFailure: "PostToolUseFailure",
  subagentStop: "SubagentStop",
};

export function registerNotificationHooks(settingsPath, notifyCommand, notifications, contextCommand) {
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  if (!settings.hooks) settings.hooks = {};

  // Register context hook for SessionStart
  if (contextCommand) {
    if (!Array.isArray(settings.hooks.SessionStart)) {
      settings.hooks.SessionStart = [];
    }
    const existingIdx = settings.hooks.SessionStart.findIndex(isCraEntry);
    const entry = { hooks: [{ type: "command", command: contextCommand }] };
    if (existingIdx >= 0) {
      settings.hooks.SessionStart[existingIdx] = entry;
    } else {
      settings.hooks.SessionStart.push(entry);
    }
  }

  // Register notification hooks for enabled types
  for (const [configKey, hookEvent] of Object.entries(NOTIFICATION_HOOK_EVENTS)) {
    if (!notifications[configKey]) continue;

    if (!Array.isArray(settings.hooks[hookEvent])) {
      settings.hooks[hookEvent] = [];
    }
    const existingIdx = settings.hooks[hookEvent].findIndex(isCraEntry);
    const entry = { hooks: [{ type: "command", command: notifyCommand }] };
    if (existingIdx >= 0) {
      settings.hooks[hookEvent][existingIdx] = entry;
    } else {
      settings.hooks[hookEvent].push(entry);
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
```

Also add a `getNotifyCommand()` export similar to `getHookCommand()`:

```javascript
export function getNotifyCommand() {
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");
  if (!fs.existsSync(cliPath)) {
    throw new Error(`CLI entry point not found: ${cliPath}`);
  }
  return `node "${cliPath}" notify`;
}

export function getContextCommand() {
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");
  if (!fs.existsSync(cliPath)) {
    throw new Error(`CLI entry point not found: ${cliPath}`);
  }
  return `node "${cliPath}" context`;
}
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/setup.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add src/setup.mjs test/setup.test.mjs
git commit -m "feat: add registerNotificationHooks for multi-hook registration"
```

---

### Task 12: Update `runSetup` to register notification hooks

**Files:**
- Modify: `src/setup.mjs` (runSetup)
- Test: `test/setup.test.mjs`

**Step 1: Write the failing tests**

Add to the `runSetup` describe block in `test/setup.test.mjs`:

```javascript
it("should register notification hooks during setup when config has notifications", async () => {
  const tmpSettingsPath2 = path.join(tmpDir, "settings-notify-setup.json");
  if (fs.existsSync(tmpSettingsPath2)) fs.unlinkSync(tmpSettingsPath2);

  await runSetup({
    configPath: tmpConfigPath,
    settingsPath: tmpSettingsPath2,
    generateTopic: () => "cra-notifysetup1",
    saveConfig: () => {},
    loadConfig: () => ({
      topic: "",
      ntfyServer: "https://ntfy.sh",
      timeout: 120,
      authToken: "",
      notifications: { idle: true, stop: true, toolFailure: true, sessionStart: false, sessionEnd: false, subagentStop: false },
    }),
  });

  const settings = JSON.parse(fs.readFileSync(tmpSettingsPath2, "utf-8"));
  assert.ok(settings.hooks.PermissionRequest, "should have PermissionRequest hook");
  assert.ok(settings.hooks.Notification, "should have Notification hook for idle");
  assert.ok(settings.hooks.Stop, "should have Stop hook");
  assert.ok(settings.hooks.PostToolUseFailure, "should have PostToolUseFailure hook");
  assert.ok(settings.hooks.SessionStart, "should have SessionStart hook for context");
  assert.equal(settings.hooks.SessionEnd, undefined, "should not have SessionEnd hook");
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/setup.test.mjs`
Expected: FAIL

**Step 3: Update `runSetup` to call `registerNotificationHooks`**

```javascript
export async function runSetup({ configPath, settingsPath, generateTopic, saveConfig, loadConfig }) {
  const topic = generateTopic();
  const config = loadConfig(configPath);
  config.topic = topic;
  saveConfig(config, configPath);

  const hookCommand = getHookCommand();
  registerHook(settingsPath, hookCommand);

  // Register notification hooks and context hook
  const notifyCommand = getNotifyCommand();
  const contextCommand = getContextCommand();
  registerNotificationHooks(settingsPath, notifyCommand, config.notifications || {}, contextCommand);

  return { topic, ntfyServer: config.ntfyServer, configPath, settingsPath };
}
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/setup.test.mjs`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/setup.mjs test/setup.test.mjs
git commit -m "feat: register notification and context hooks during setup"
```

---

### Task 13: Update `status` command to show auth and notification config

**Files:**
- Modify: `bin/cli.mjs` (status case)
- Test: `test/cli.test.mjs`

**Step 1: Write the failing tests**

Add to the `status subcommand` describe block in `test/cli.test.mjs`:

```javascript
it("should show auth status when authToken is configured", async () => {
  const stdout = createMockWriter();
  const deps = createDeps({
    stdout,
    config: {
      topic: "cra-abc",
      ntfyServer: "https://ntfy.example.com",
      timeout: 120,
      authToken: "tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2",
      notifications: { idle: true, stop: true, sessionStart: false, sessionEnd: false, toolFailure: true, subagentStop: false, stopWithContinue: false },
    },
  });

  await main(["status"], deps);

  const output = stdout.output();
  assert.ok(output.includes("Auth:"), `should show Auth line, got: ${output}`);
  assert.ok(output.includes("configured"), `should show auth configured, got: ${output}`);
});

it("should show notification status", async () => {
  const stdout = createMockWriter();
  const deps = createDeps({
    stdout,
    config: {
      topic: "cra-abc",
      ntfyServer: "https://ntfy.sh",
      timeout: 120,
      authToken: "",
      notifications: { idle: true, stop: true, sessionStart: false, sessionEnd: false, toolFailure: true, subagentStop: false, stopWithContinue: false },
    },
  });

  await main(["status"], deps);

  const output = stdout.output();
  assert.ok(output.includes("Notifications:"), `should show Notifications section, got: ${output}`);
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/cli.test.mjs`
Expected: FAIL

**Step 3: Update status command**

```javascript
case "status": {
  const config = deps.loadConfig();
  deps.stdout.write(`Topic:   ${config.topic}\n`);
  deps.stdout.write(`Server:  ${config.ntfyServer}\n`);
  deps.stdout.write(`Auth:    ${config.authToken ? `${config.authToken.slice(0, 7)}... (configured)` : "none"}\n`);
  deps.stdout.write(`Timeout: ${config.timeout}s / ${config.planTimeout ?? 300}s (plan)\n`);
  if (config.notifications) {
    deps.stdout.write("Notifications:\n");
    const labels = {
      idle: "Idle prompt",
      stop: "Stop (finished)",
      sessionStart: "Session start",
      sessionEnd: "Session end",
      toolFailure: "Tool failure",
      subagentStop: "Subagent stop",
    };
    for (const [key, label] of Object.entries(labels)) {
      const enabled = config.notifications[key];
      deps.stdout.write(`  ${enabled ? "\u2713" : "\u2717"} ${label}\n`);
    }
  }
  break;
}
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/cli.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add bin/cli.mjs test/cli.test.mjs
git commit -m "feat: show auth and notification status in status command"
```

---

## Phase 3: Question Flow Improvements (v0.9.0)

### Task 14: Add "Use CLI" fallback button to question notifications

**Files:**
- Modify: `src/hook.mjs` (processAskUserQuestion, buildQuestionActions)
- Test: `test/hook.test.mjs`

**Step 1: Write the failing tests**

Add to `test/hook.test.mjs`:

```javascript
describe("Use CLI fallback button", () => {
  it("should include a 'Use CLI' action in the last batch of question actions", () => {
    const options = [
      { label: "A", description: "First" },
      { label: "B", description: "Second" },
    ];
    const actions = buildQuestionActions("https://ntfy.sh", "my-topic", "req-cli", options, { includeCliButton: true });

    const cliAction = actions.find(a => a.label === "Use CLI");
    assert.ok(cliAction, "should have a 'Use CLI' action");
    const body = JSON.parse(cliAction.body);
    assert.equal(body.useCLI, true);
  });

  it("processAskUserQuestion should return ASK when useCLI response is received", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which?",
          header: "Choice",
          options: [{ label: "A", description: "First" }],
          multiSelect: false,
        }],
      },
    };

    const result = await processAskUserQuestion(input, {
      loadConfig: () => ({ topic: "t", ntfyServer: "https://ntfy.sh", timeout: 120, authToken: "" }),
      sendNotification: async () => ({ ok: true }),
      waitForResponse: async () => ({ answer: "__USE_CLI__" }),
    });

    assert.equal(result.hookSpecificOutput.decision.behavior, "ask");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/hook.test.mjs`
Expected: FAIL

**Step 3: Implement "Use CLI" button**

Update `buildQuestionActions` to accept `includeCliButton` option:

```javascript
export function buildQuestionActions(server, topic, requestId, options, { authToken, includeCliButton } = {}) {
  const url = `${server}/${topic}-response`;
  const actions = options.map((opt) => {
    const action = {
      action: "http",
      label: opt.label,
      url,
      body: JSON.stringify({ requestId, answer: opt.label }),
      method: "POST",
    };
    if (authToken) {
      action.headers = { Authorization: `Bearer ${authToken}` };
    }
    return action;
  });

  if (includeCliButton) {
    const cliAction = {
      action: "http",
      label: "Use CLI",
      url,
      body: JSON.stringify({ requestId, answer: "__USE_CLI__", useCLI: true }),
      method: "POST",
    };
    if (authToken) {
      cliAction.headers = { Authorization: `Bearer ${authToken}` };
    }
    actions.push(cliAction);
  }

  return actions;
}
```

Update `processAskUserQuestion` to:
1. Pass `includeCliButton: true` to the last batch's `buildQuestionActions`
2. Check for `__USE_CLI__` answer and return ASK

**Step 4: Run tests to verify they pass**

Run: `node --test test/hook.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add src/hook.mjs test/hook.test.mjs
git commit -m "feat: add Use CLI fallback button to question notifications"
```

---

### Task 15: Multi-question sequence support

**Files:**
- Modify: `src/hook.mjs` (processAskUserQuestion — already loops, but verify all questions are processed)
- Test: `test/hook.test.mjs`

The current code already loops through `questions` in `processAskUserQuestion`. Verify with tests that multi-question flows work correctly end-to-end.

**Step 1: Write the tests**

```javascript
describe("multi-question sequences", () => {
  it("should process all questions sequentially and return answers for each", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "Q1?", header: "H1", options: [{ label: "A1", description: "D1" }], multiSelect: false },
          { question: "Q2?", header: "H2", options: [{ label: "B1", description: "D2" }], multiSelect: false },
        ],
      },
    };

    let callNum = 0;
    const result = await processAskUserQuestion(input, {
      loadConfig: () => ({ topic: "t", ntfyServer: "https://ntfy.sh", timeout: 120, authToken: "" }),
      sendNotification: async () => ({ ok: true }),
      waitForResponse: async () => {
        callNum++;
        return { answer: callNum === 1 ? "A1" : "B1" };
      },
    });

    assert.equal(result.hookSpecificOutput.decision.behavior, "allow");
    const answers = result.hookSpecificOutput.decision.updatedInput.answers;
    assert.equal(answers["Q1?"], "A1");
    assert.equal(answers["Q2?"], "B1");
  });

  it("should fall back to CLI if any question times out", async () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "Q1?", header: "H1", options: [{ label: "A1", description: "D1" }], multiSelect: false },
          { question: "Q2?", header: "H2", options: [{ label: "B1", description: "D2" }], multiSelect: false },
        ],
      },
    };

    let callNum = 0;
    const result = await processAskUserQuestion(input, {
      loadConfig: () => ({ topic: "t", ntfyServer: "https://ntfy.sh", timeout: 120, authToken: "" }),
      sendNotification: async () => ({ ok: true }),
      waitForResponse: async () => {
        callNum++;
        if (callNum === 2) return { timeout: true };
        return { answer: "A1" };
      },
    });

    assert.equal(result.hookSpecificOutput.decision.behavior, "ask");
  });
});
```

**Step 2: Run tests**

Run: `node --test test/hook.test.mjs`
Expected: These should mostly PASS already since multi-question is implemented. If any fail, fix the implementation.

**Step 3: Commit (if any changes needed)**

```bash
git add src/hook.mjs test/hook.test.mjs
git commit -m "test: add multi-question sequence tests"
```

---

### Task 16: Add markdown rendering to question notifications

**Files:**
- Modify: `src/hook.mjs` (processAskUserQuestion — add `markdown: true` to sendNotification)
- Test: `test/hook.test.mjs`

**Step 1: Write the failing test**

```javascript
it("should include markdown: true in question notification when options have preview content", async () => {
  const sendCalls = [];
  const input = {
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [{
        question: "Which layout?",
        header: "Layout",
        options: [
          { label: "A", description: "Sidebar", markdown: "```\n┌─────┐\n│ Side│\n└─────┘\n```" },
          { label: "B", description: "Top nav" },
        ],
        multiSelect: false,
      }],
    },
  };

  await processAskUserQuestion(input, {
    loadConfig: () => ({ topic: "t", ntfyServer: "https://ntfy.sh", timeout: 120, authToken: "" }),
    sendNotification: async (params) => { sendCalls.push(params); return { ok: true }; },
    waitForResponse: async () => ({ answer: "A" }),
  });

  // Notifications should include preview content in the message body
  assert.ok(sendCalls[0].message.includes("Sidebar"));
});
```

**Step 2: Run tests, implement if needed, commit**

The `buildQuestionMessage` already includes option descriptions. For preview content, extend it to include `markdown` content from options when present. This is a small change to `buildQuestionMessage`.

```bash
git add src/hook.mjs test/hook.test.mjs
git commit -m "feat: include option preview content in question notifications"
```

---

### Task 17: Final integration — update `unregisterHook` to clean up all hook types

**Files:**
- Modify: `src/setup.mjs` (unregisterHook or new unregisterAllHooks)
- Test: `test/setup.test.mjs`

**Step 1: Write the failing tests**

```javascript
describe("unregisterAllHooks", () => {
  it("should remove CRA entries from all hook event types", () => {
    const settingsPath = path.join(tmpDir, "unregister-all.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PermissionRequest: [
          { hooks: [{ type: "command", command: "node /path/claude-remote-approver/bin/cli.mjs hook" }] },
        ],
        Notification: [
          { hooks: [{ type: "command", command: "node /path/claude-remote-approver/bin/cli.mjs notify" }] },
        ],
        Stop: [
          { hooks: [{ type: "command", command: "echo other" }] },
          { hooks: [{ type: "command", command: "node /path/claude-remote-approver/bin/cli.mjs notify" }] },
        ],
        SessionStart: [
          { hooks: [{ type: "command", command: "node /path/claude-remote-approver/bin/cli.mjs context" }] },
        ],
      },
    }, null, 2));

    unregisterAllHooks(settingsPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(settings.hooks.PermissionRequest, undefined);
    assert.equal(settings.hooks.Notification, undefined);
    assert.equal(settings.hooks.SessionStart, undefined);
    // Stop should still have the non-CRA entry
    assert.equal(settings.hooks.Stop.length, 1);
    assert.equal(settings.hooks.Stop[0].hooks[0].command, "echo other");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/setup.test.mjs`
Expected: FAIL

**Step 3: Implement `unregisterAllHooks`**

```javascript
const ALL_HOOK_EVENTS = ["PermissionRequest", "Notification", "Stop", "SessionStart", "SessionEnd", "PostToolUseFailure", "SubagentStop"];

export function unregisterAllHooks(settingsPath) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }

  if (!settings.hooks) return;

  for (const event of ALL_HOOK_EVENTS) {
    if (!settings.hooks[event]) continue;
    const filtered = settings.hooks[event].filter((entry) => !isCraEntry(entry));
    if (filtered.length === 0) {
      delete settings.hooks[event];
    } else {
      settings.hooks[event] = filtered;
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
```

Update `disable` and `uninstall` CLI commands to call `unregisterAllHooks` instead of `unregisterHook`.

**Step 4: Run tests to verify they pass**

Run: `node --test test/setup.test.mjs`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/setup.mjs test/setup.test.mjs bin/cli.mjs test/cli.test.mjs
git commit -m "feat: add unregisterAllHooks for cleaning up all CRA hook entries"
```

---

### Task 18: Version bump and final verification

**Files:**
- Modify: `package.json`

**Step 1: Bump version**

Update `package.json` version to `0.7.0`.

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests PASS (update version-related tests if needed)

**Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 0.7.0"
```

---

## Deferred to Later Phases

The following PRD features are intentionally deferred. They can be implemented in separate plans after Phase 1-3 are stable:

- **Phase 4 (v0.10.0):** Multi-select answer accumulation in `waitForResponse`, confirmation notifications, "Continue" button on Stop notifications, `stopWithContinue` config support
- **Setup flow changes:** Interactive auth prompts, HTTPS enforcement with override, token validation round-trip
- **Config command:** Dedicated `claude-remote-approver config` for toggling notification types interactively
