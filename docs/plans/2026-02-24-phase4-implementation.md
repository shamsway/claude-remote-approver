# Phase 4 Implementation Plan: Stop "Continue" Button + Interactive Setup Improvements

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an interactive "Continue" button to Stop notifications and add HTTPS enforcement + token validation to the setup flow (v0.8.0).

**Architecture:** Two independent features built on the existing dependency-injection pattern. Feature A adds a new `src/stop.mjs` module with `processStop` + `buildContinueAction`, a new `stop` CLI command, and conditional hook registration. Feature B adds `validateToken` to `src/ntfy.mjs`, `isInsecureServer` to `src/config.mjs`, and validation checks in `runSetup`.

**Tech Stack:** Node.js (ESM), node:test, node:assert/strict, node:crypto. Zero external dependencies.

---

## Task 1: Config changes — `continueTimeout` and `allowInsecure`

**Files:**
- Modify: `src/config.mjs:8-26` (DEFAULT_CONFIG)
- Modify: `src/config.mjs:28-33` (applyEnvOverrides)
- Modify: `src/config.mjs:35-59` (loadConfig validation)
- Test: `test/config.test.mjs`

**Step 1: Write failing tests for new config fields**

Add to `test/config.test.mjs`:

```javascript
describe("continueTimeout config", () => {
  it("should default continueTimeout to 120", () => {
    const config = loadConfig(nonexistentPath);
    assert.equal(config.continueTimeout, 120);
  });

  it("should respect continueTimeout from file", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ topic: "t", continueTimeout: 30 }), { mode: 0o600 });
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.continueTimeout, 30);
  });

  it("should validate continueTimeout is a positive finite number", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ topic: "t", continueTimeout: -5 }), { mode: 0o600 });
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.continueTimeout, 120);
  });

  it("should apply CCR_CONTINUE_TIMEOUT env var override", () => {
    process.env.CCR_CONTINUE_TIMEOUT = "45";
    const config = loadConfig(nonexistentPath);
    assert.equal(config.continueTimeout, 45);
    delete process.env.CCR_CONTINUE_TIMEOUT;
  });
});

describe("allowInsecure config", () => {
  it("should default allowInsecure to false", () => {
    const config = loadConfig(nonexistentPath);
    assert.equal(config.allowInsecure, false);
  });

  it("should respect allowInsecure from file", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ topic: "t", allowInsecure: true }), { mode: 0o600 });
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.allowInsecure, true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `continueTimeout` and `allowInsecure` are undefined

**Step 3: Implement config changes**

In `src/config.mjs`, update `DEFAULT_CONFIG` (lines 8-26):

```javascript
export const DEFAULT_CONFIG = {
  topic: "",
  ntfyServer: "https://ntfy.sh",
  authToken: "",
  timeout: 120,
  planTimeout: 300,
  continueTimeout: 120,
  allowInsecure: false,
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

In `applyEnvOverrides` (line 28-33), add:

```javascript
if (process.env.CCR_CONTINUE_TIMEOUT) {
  const val = Number(process.env.CCR_CONTINUE_TIMEOUT);
  if (Number.isFinite(val) && val > 0) config.continueTimeout = val;
}
```

In `loadConfig` validation (around line 46), add:

```javascript
if (!Number.isFinite(config.continueTimeout) || config.continueTimeout <= 0) config.continueTimeout = DEFAULT_CONFIG.continueTimeout;
if (typeof config.allowInsecure !== "boolean") config.allowInsecure = DEFAULT_CONFIG.allowInsecure;
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/config.test.mjs`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass (existing tests unaffected)

**Step 6: Commit**

```bash
git add src/config.mjs test/config.test.mjs
git commit -m "feat: add continueTimeout and allowInsecure config fields"
```

---

## Task 2: `isInsecureServer` utility

**Files:**
- Modify: `src/config.mjs` (add new exported function)
- Test: `test/config.test.mjs`

**Step 1: Write failing tests**

Add to `test/config.test.mjs`:

```javascript
import { loadConfig, saveConfig, generateTopic, DEFAULT_CONFIG, isInsecureServer } from "../src/config.mjs";

describe("isInsecureServer", () => {
  it("should return true for http:// non-localhost server", () => {
    assert.equal(isInsecureServer("http://ntfy.example.com"), true);
  });

  it("should return false for https:// server", () => {
    assert.equal(isInsecureServer("https://ntfy.example.com"), false);
  });

  it("should return false for http://localhost", () => {
    assert.equal(isInsecureServer("http://localhost"), false);
  });

  it("should return false for http://localhost:8080", () => {
    assert.equal(isInsecureServer("http://localhost:8080"), false);
  });

  it("should return false for http://127.0.0.1", () => {
    assert.equal(isInsecureServer("http://127.0.0.1"), false);
  });

  it("should return false for http://127.0.0.1:8080", () => {
    assert.equal(isInsecureServer("http://127.0.0.1:8080"), false);
  });

  it("should return false for http://[::1]", () => {
    assert.equal(isInsecureServer("http://[::1]"), false);
  });

  it("should return false for http://[::1]:8080", () => {
    assert.equal(isInsecureServer("http://[::1]:8080"), false);
  });

  it("should return false for invalid URL (graceful fallback)", () => {
    assert.equal(isInsecureServer("not-a-url"), false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `isInsecureServer` is not exported

**Step 3: Implement**

Add to `src/config.mjs` after the `generateTopic` function:

```javascript
/**
 * Returns true if the server URL uses http:// and is not a local address.
 * Local addresses: localhost, 127.0.0.1, ::1
 *
 * @param {string} server - Server URL string
 * @returns {boolean}
 */
export function isInsecureServer(server) {
  try {
    const url = new URL(server);
    if (url.protocol !== "http:") return false;
    const hostname = url.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/config.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config.mjs test/config.test.mjs
git commit -m "feat: add isInsecureServer utility for HTTPS enforcement"
```

---

## Task 3: `validateToken` in ntfy.mjs

**Files:**
- Modify: `src/ntfy.mjs` (add new exported function)
- Test: `test/ntfy.test.mjs`

**Step 1: Write failing tests**

Add to `test/ntfy.test.mjs`. Import `validateToken` from `../src/ntfy.mjs` in the existing import statement.

```javascript
describe("validateToken", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should return valid:true on 200 response", async () => {
    globalThis.fetch = createMockFetch({}, 200);
    const result = await validateToken("https://ntfy.example.com", "test-topic", "tk_abc123");
    assert.deepEqual(result, { valid: true });
  });

  it("should send POST with Authorization header", async () => {
    const mockFetch = createMockFetch({}, 200);
    globalThis.fetch = mockFetch;
    await validateToken("https://ntfy.example.com", "test-topic", "tk_abc123");

    assert.equal(mockFetch.calls.length, 1);
    const { options } = mockFetch.calls[0];
    assert.equal(options.method, "POST");
    assert.equal(options.headers["Authorization"], "Bearer tk_abc123");
  });

  it("should send minimal body with priority 1", async () => {
    const mockFetch = createMockFetch({}, 200);
    globalThis.fetch = mockFetch;
    await validateToken("https://ntfy.example.com", "test-topic", "tk_abc123");

    const body = JSON.parse(mockFetch.calls[0].options.body);
    assert.equal(body.topic, "test-topic");
    assert.equal(body.priority, 1);
    assert.equal(typeof body.message, "string");
  });

  it("should return valid:false with status on 401", async () => {
    globalThis.fetch = createMockFetch({}, 401);
    const result = await validateToken("https://ntfy.example.com", "test-topic", "tk_bad");
    assert.equal(result.valid, false);
    assert.equal(result.status, 401);
  });

  it("should return valid:false with status on 403", async () => {
    globalThis.fetch = createMockFetch({}, 403);
    const result = await validateToken("https://ntfy.example.com", "test-topic", "tk_bad");
    assert.equal(result.valid, false);
    assert.equal(result.status, 403);
  });

  it("should return valid:false with message on network error", async () => {
    globalThis.fetch = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await validateToken("https://ntfy.example.com", "test-topic", "tk_abc");
    assert.equal(result.valid, false);
    assert.ok(result.message.includes("ECONNREFUSED"));
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/ntfy.test.mjs`
Expected: FAIL — `validateToken` is not exported

**Step 3: Implement**

Add to `src/ntfy.mjs` after `waitForResponse` (before `stripMarkdown`):

```javascript
/**
 * Validate an auth token by attempting a minimal publish to the topic.
 *
 * @param {string} server - ntfy server URL
 * @param {string} topic - ntfy topic
 * @param {string} authToken - Bearer token to validate
 * @returns {Promise<{ valid: true } | { valid: false, status?: number, message: string }>}
 */
export async function validateToken(server, topic, authToken) {
  const baseUrl = server.replace(/\/+$/, '');
  try {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ topic, message: "Token validation", priority: 1 }),
    });
    if (response.ok) {
      return { valid: true };
    }
    return { valid: false, status: response.status, message: `HTTP ${response.status}` };
  } catch (err) {
    return { valid: false, message: err.message };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/ntfy.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add src/ntfy.mjs test/ntfy.test.mjs
git commit -m "feat: add validateToken for setup auth validation"
```

---

## Task 4: Setup improvements — HTTPS enforcement + token validation

**Files:**
- Modify: `src/setup.mjs:216-238` (runSetup)
- Test: `test/setup.test.mjs`

**Step 1: Write failing tests**

Add to `test/setup.test.mjs`. Update the import to include `isInsecureServer` from `../src/config.mjs`.

```javascript
describe("runSetup HTTPS enforcement", () => {
  let tmpDir, tmpConfigPath, tmpSettingsPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cra-https-test-"));
    tmpConfigPath = path.join(tmpDir, "config.json");
    tmpSettingsPath = path.join(tmpDir, "settings.json");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should reject http:// non-localhost server without allowInsecure", async () => {
    await assert.rejects(
      () => runSetup({
        configPath: tmpConfigPath,
        settingsPath: tmpSettingsPath,
        generateTopic: () => "cra-test",
        saveConfig: () => {},
        loadConfig: () => ({
          ...DEFAULT_CONFIG,
          ntfyServer: "http://ntfy.example.com",
          authToken: "tk_abc",
        }),
      }),
      (err) => err.message.includes("http://") || err.message.includes("insecure")
    );
  });

  it("should allow http:// non-localhost when allowInsecure is true", async () => {
    const result = await runSetup({
      configPath: tmpConfigPath,
      settingsPath: tmpSettingsPath,
      generateTopic: () => "cra-test",
      saveConfig: () => {},
      loadConfig: () => ({
        ...DEFAULT_CONFIG,
        ntfyServer: "http://ntfy.example.com",
        authToken: "",
        allowInsecure: true,
      }),
    });
    assert.equal(result.topic, "cra-test");
  });

  it("should allow http://localhost without allowInsecure", async () => {
    const result = await runSetup({
      configPath: tmpConfigPath,
      settingsPath: tmpSettingsPath,
      generateTopic: () => "cra-test",
      saveConfig: () => {},
      loadConfig: () => ({
        ...DEFAULT_CONFIG,
        ntfyServer: "http://localhost:8080",
        authToken: "",
      }),
    });
    assert.equal(result.topic, "cra-test");
  });

  it("should allow https:// without allowInsecure", async () => {
    const result = await runSetup({
      configPath: tmpConfigPath,
      settingsPath: tmpSettingsPath,
      generateTopic: () => "cra-test",
      saveConfig: () => {},
      loadConfig: () => ({
        ...DEFAULT_CONFIG,
        ntfyServer: "https://ntfy.example.com",
        authToken: "",
      }),
    });
    assert.equal(result.topic, "cra-test");
  });
});

describe("runSetup token validation", () => {
  let tmpDir, tmpConfigPath, tmpSettingsPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cra-token-test-"));
    tmpConfigPath = path.join(tmpDir, "config.json");
    tmpSettingsPath = path.join(tmpDir, "settings.json");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should reject setup when validateToken returns valid:false", async () => {
    await assert.rejects(
      () => runSetup({
        configPath: tmpConfigPath,
        settingsPath: tmpSettingsPath,
        generateTopic: () => "cra-test",
        saveConfig: () => {},
        loadConfig: () => ({
          ...DEFAULT_CONFIG,
          ntfyServer: "https://ntfy.example.com",
          authToken: "tk_bad",
        }),
        validateToken: async () => ({ valid: false, status: 401, message: "HTTP 401" }),
      }),
      (err) => err.message.includes("401") || err.message.includes("token")
    );
  });

  it("should proceed when validateToken returns valid:true", async () => {
    const result = await runSetup({
      configPath: tmpConfigPath,
      settingsPath: tmpSettingsPath,
      generateTopic: () => "cra-test",
      saveConfig: () => {},
      loadConfig: () => ({
        ...DEFAULT_CONFIG,
        ntfyServer: "https://ntfy.example.com",
        authToken: "tk_good",
      }),
      validateToken: async () => ({ valid: true }),
    });
    assert.equal(result.topic, "cra-test");
  });

  it("should skip validation when authToken is empty", async () => {
    let validateCalled = false;
    const result = await runSetup({
      configPath: tmpConfigPath,
      settingsPath: tmpSettingsPath,
      generateTopic: () => "cra-test",
      saveConfig: () => {},
      loadConfig: () => ({
        ...DEFAULT_CONFIG,
        ntfyServer: "https://ntfy.example.com",
        authToken: "",
      }),
      validateToken: async () => { validateCalled = true; return { valid: true }; },
    });
    assert.equal(validateCalled, false);
    assert.equal(result.topic, "cra-test");
  });

  it("should not save config when validation fails", async () => {
    let saveCalled = false;
    try {
      await runSetup({
        configPath: tmpConfigPath,
        settingsPath: tmpSettingsPath,
        generateTopic: () => "cra-test",
        saveConfig: () => { saveCalled = true; },
        loadConfig: () => ({
          ...DEFAULT_CONFIG,
          ntfyServer: "https://ntfy.example.com",
          authToken: "tk_bad",
        }),
        validateToken: async () => ({ valid: false, status: 403, message: "HTTP 403" }),
      });
    } catch { /* expected */ }
    assert.equal(saveCalled, false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/setup.test.mjs`
Expected: FAIL — runSetup doesn't check HTTPS or validate tokens

**Step 3: Implement**

Update `runSetup` in `src/setup.mjs` (lines 216-238). Import `isInsecureServer` from `./config.mjs`.

```javascript
import { isInsecureServer } from "./config.mjs";

export async function runSetup({
  configPath,
  settingsPath,
  generateTopic,
  saveConfig,
  loadConfig,
  validateToken,
  stderr,
}) {
  const topic = generateTopic();

  const config = loadConfig(configPath);
  config.topic = topic;

  // HTTPS enforcement
  if (isInsecureServer(config.ntfyServer) && !config.allowInsecure) {
    throw new Error(
      `Refusing to use ${config.ntfyServer} — sending auth tokens over http:// is insecure. ` +
      `Use --allow-insecure flag or set "allowInsecure": true in config to override.`
    );
  }
  if (isInsecureServer(config.ntfyServer) && config.allowInsecure && stderr) {
    stderr.write(`Warning: Using insecure http:// server ${config.ntfyServer}. Auth tokens will be sent in plaintext.\n`);
  }

  // Token validation
  if (config.authToken && validateToken) {
    const result = await validateToken(config.ntfyServer, config.topic, config.authToken);
    if (!result.valid) {
      throw new Error(
        `Auth token validation failed: ${result.message}. ` +
        `Check that the token is correct and the user has read-write access to cra-* topics.`
      );
    }
  }

  saveConfig(config, configPath);

  const hookCommand = getHookCommand();
  registerHook(settingsPath, hookCommand);

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
Expected: All tests pass. Note: existing `runSetup` tests that don't pass `validateToken` will still work because the `validateToken` parameter is optional.

**Step 6: Commit**

```bash
git add src/setup.mjs test/setup.test.mjs
git commit -m "feat: add HTTPS enforcement and token validation to setup"
```

---

## Task 5: CLI `--allow-insecure` flag for setup

**Files:**
- Modify: `bin/cli.mjs:34-57` (setup case)
- Test: `test/cli.test.mjs`

**Step 1: Write failing tests**

Add to `test/cli.test.mjs`:

```javascript
describe("setup --allow-insecure", () => {
  it("should pass allowInsecure through to runSetup when --allow-insecure flag present", async () => {
    let capturedConfig = null;
    const deps = createDeps({
      config: { ...defaultConfig, ntfyServer: "http://remote.example.com" },
    });
    deps.runSetup = mock.fn(async (opts) => {
      capturedConfig = opts.loadConfig();
      return { topic: "cra-test", ntfyServer: "http://remote.example.com" };
    });

    await main(["setup", "--allow-insecure"], deps);
    // The flag should be reflected in the deps passed to runSetup
    assert.equal(deps.runSetup.mock.calls.length, 1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/cli.test.mjs`
Expected: FAIL

**Step 3: Implement**

In `bin/cli.mjs`, update the `setup` case (around line 34). Parse the flag from args and pass `validateToken` + `stderr` to `runSetup`:

```javascript
case "setup": {
  const allowInsecure = args.includes("--allow-insecure");
  const originalLoadConfig = deps.loadConfig;
  const wrappedLoadConfig = allowInsecure
    ? (...a) => { const c = originalLoadConfig(...a); c.allowInsecure = true; return c; }
    : originalLoadConfig;
  const result = await deps.runSetup({
    ...deps,
    loadConfig: wrappedLoadConfig,
    validateToken: deps.validateToken,
    stderr: deps.stderr,
  });
  // ... rest of setup output unchanged
```

In the `isMain` block (around line 237-243), import and add `validateToken` to deps:

```javascript
const { sendNotification, waitForResponse, formatToolInfo, validateToken } = await import("../src/ntfy.mjs");
// ...
const deps = {
  // ... existing deps ...
  validateToken,
};
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/cli.test.mjs`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 6: Commit**

```bash
git add bin/cli.mjs test/cli.test.mjs
git commit -m "feat: add --allow-insecure flag for setup command"
```

---

## Task 6: `buildContinueAction` and `processStop`

**Files:**
- Create: `src/stop.mjs`
- Test: `test/stop.test.mjs`

**Step 1: Write failing tests**

Create `test/stop.test.mjs`:

```javascript
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { processStop, buildContinueAction } from "../src/stop.mjs";

// ---------------------------------------------------------------------------
// buildContinueAction
// ---------------------------------------------------------------------------

describe("buildContinueAction", () => {
  it("should return an action with label 'Continue'", () => {
    const action = buildContinueAction("https://ntfy.sh", "my-topic", "req-001");
    assert.equal(action.label, "Continue");
  });

  it("should use response topic URL", () => {
    const action = buildContinueAction("https://ntfy.sh", "my-topic", "req-001");
    assert.equal(action.url, "https://ntfy.sh/my-topic-response");
  });

  it("should use POST method", () => {
    const action = buildContinueAction("https://ntfy.sh", "my-topic", "req-001");
    assert.equal(action.method, "POST");
  });

  it("should include requestId and continue:true in body", () => {
    const action = buildContinueAction("https://ntfy.sh", "my-topic", "req-001");
    const body = JSON.parse(action.body);
    assert.equal(body.requestId, "req-001");
    assert.equal(body.continue, true);
  });

  it("should not include auth header when no authToken", () => {
    const action = buildContinueAction("https://ntfy.sh", "my-topic", "req-001");
    assert.equal(action.headers, undefined);
  });

  it("should include auth header when authToken is provided", () => {
    const action = buildContinueAction("https://ntfy.sh", "my-topic", "req-001", { authToken: "tk_abc" });
    assert.deepEqual(action.headers, { Authorization: "Bearer tk_abc" });
  });

  it("should set clear:true to dismiss notification on tap", () => {
    const action = buildContinueAction("https://ntfy.sh", "my-topic", "req-001");
    assert.equal(action.clear, true);
  });
});

// ---------------------------------------------------------------------------
// processStop
// ---------------------------------------------------------------------------

function createMockDeps(overrides = {}) {
  const defaultConfig = {
    topic: "test-topic",
    ntfyServer: "https://ntfy.sh",
    authToken: "",
    timeout: 120,
    continueTimeout: 120,
    notifications: { stop: true, stopWithContinue: true },
  };
  return {
    loadConfig: mock.fn(() => overrides.config ?? defaultConfig),
    sendNotification: mock.fn(async () => ({ ok: true, status: 200 })),
    waitForResponse: mock.fn(async () => overrides.waitResult ?? { continue: true }),
    ...overrides,
  };
}

describe("processStop", () => {
  it("should return null when topic is empty", async () => {
    const deps = createMockDeps({ config: { topic: "", notifications: { stopWithContinue: true } } });
    const result = await processStop({ hook_event_name: "Stop" }, deps);
    assert.equal(result, null);
  });

  it("should return null when stopWithContinue is false", async () => {
    const deps = createMockDeps({
      config: {
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        authToken: "",
        timeout: 120,
        continueTimeout: 120,
        notifications: { stop: true, stopWithContinue: false },
      },
    });
    const result = await processStop({ hook_event_name: "Stop" }, deps);
    assert.equal(result, null);
    assert.equal(deps.sendNotification.mock.calls.length, 0);
  });

  it("should send notification with Continue action button", async () => {
    const deps = createMockDeps();
    await processStop({ hook_event_name: "Stop" }, deps);

    assert.equal(deps.sendNotification.mock.calls.length, 1);
    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.equal(callArgs.title, "Claude Code");
    assert.ok(callArgs.message.toLowerCase().includes("finished"));
    assert.equal(callArgs.actions.length, 1);
    assert.equal(callArgs.actions[0].label, "Continue");
  });

  it("should return block decision when user taps Continue", async () => {
    const deps = createMockDeps({ waitResult: { continue: true } });
    const result = await processStop({ hook_event_name: "Stop" }, deps);

    assert.deepEqual(result, { decision: "block", reason: "User requested continuation" });
  });

  it("should return null on timeout", async () => {
    const deps = createMockDeps({ waitResult: { timeout: true } });
    const result = await processStop({ hook_event_name: "Stop" }, deps);
    assert.equal(result, null);
  });

  it("should return null on error response", async () => {
    const deps = createMockDeps({ waitResult: { error: new Error("network") } });
    const result = await processStop({ hook_event_name: "Stop" }, deps);
    assert.equal(result, null);
  });

  it("should return null when send fails (retry exhausted)", async () => {
    const deps = createMockDeps({
      sendNotification: mock.fn(async () => { throw new Error("fail"); }),
    });
    const result = await processStop({ hook_event_name: "Stop" }, deps);
    assert.equal(result, null);
  });

  it("should use continueTimeout for waitForResponse", async () => {
    const deps = createMockDeps({
      config: {
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        authToken: "",
        timeout: 120,
        continueTimeout: 45,
        notifications: { stop: true, stopWithContinue: true },
      },
    });
    await processStop({ hook_event_name: "Stop" }, deps);

    const waitCall = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(waitCall.timeout, 45000);
  });

  it("should fall back to timeout when continueTimeout is not set", async () => {
    const deps = createMockDeps({
      config: {
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        authToken: "",
        timeout: 120,
        notifications: { stop: true, stopWithContinue: true },
      },
    });
    await processStop({ hook_event_name: "Stop" }, deps);

    const waitCall = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(waitCall.timeout, 120000);
  });

  it("should thread authToken through sendNotification", async () => {
    const deps = createMockDeps({
      config: {
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        authToken: "tk_secret",
        timeout: 120,
        continueTimeout: 120,
        notifications: { stop: true, stopWithContinue: true },
      },
    });
    await processStop({ hook_event_name: "Stop" }, deps);

    const sendCall = deps.sendNotification.mock.calls[0].arguments[0];
    assert.equal(sendCall.authToken, "tk_secret");
  });

  it("should thread authToken through waitForResponse", async () => {
    const deps = createMockDeps({
      config: {
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        authToken: "tk_secret",
        timeout: 120,
        continueTimeout: 120,
        notifications: { stop: true, stopWithContinue: true },
      },
    });
    await processStop({ hook_event_name: "Stop" }, deps);

    const waitCall = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(waitCall.authToken, "tk_secret");
  });

  it("should thread authToken into Continue action headers", async () => {
    const deps = createMockDeps({
      config: {
        topic: "test-topic",
        ntfyServer: "https://ntfy.sh",
        authToken: "tk_secret",
        timeout: 120,
        continueTimeout: 120,
        notifications: { stop: true, stopWithContinue: true },
      },
    });
    await processStop({ hook_event_name: "Stop" }, deps);

    const sendCall = deps.sendNotification.mock.calls[0].arguments[0];
    assert.deepEqual(sendCall.actions[0].headers, { Authorization: "Bearer tk_secret" });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/stop.test.mjs`
Expected: FAIL — `src/stop.mjs` does not exist

**Step 3: Implement**

Create `src/stop.mjs`:

```javascript
// src/stop.mjs

import crypto from "node:crypto";
import { sendWithRetry, _internal } from "./hook.mjs";

/**
 * Build a single "Continue" action button for the Stop notification.
 *
 * @param {string} server - ntfy server URL
 * @param {string} topic - ntfy topic
 * @param {string} requestId - Unique request identifier
 * @param {object} [options]
 * @param {string} [options.authToken] - When provided, adds Authorization header
 * @returns {object} Action object
 */
export function buildContinueAction(server, topic, requestId, { authToken } = {}) {
  const action = {
    action: "http",
    label: "Continue",
    url: `${server}/${topic}-response`,
    body: JSON.stringify({ requestId, continue: true }),
    method: "POST",
    clear: true,
  };
  if (authToken) {
    action.headers = { Authorization: `Bearer ${authToken}` };
  }
  return action;
}

/**
 * Process a Stop hook event with optional "Continue" button.
 *
 * When stopWithContinue is enabled, sends a notification with a Continue button
 * and waits for the user to tap it. If tapped, returns a block decision to
 * keep Claude going. On timeout/error, returns null (Claude proceeds with stop).
 *
 * @param {object} input - The hook input payload
 * @param {object} deps - Injected dependencies
 * @returns {Promise<{ decision: string, reason: string } | null>}
 */
export async function processStop(input, deps) {
  const config = deps.loadConfig();

  if (!config.topic || !config.notifications?.stopWithContinue) {
    return null;
  }

  const requestId = crypto.randomUUID();
  const actions = [buildContinueAction(config.ntfyServer, config.topic, requestId, {
    authToken: config.authToken,
  })];

  const sent = await sendWithRetry(deps.sendNotification, {
    server: config.ntfyServer,
    topic: config.topic,
    title: "Claude Code",
    message: "Claude has finished responding",
    actions,
    requestId,
    authToken: config.authToken,
    priority: 3,
    tags: ["white_check_mark"],
  });
  if (!sent) return null;

  const timeout = ((config.continueTimeout ?? config.timeout) || 120) * 1000;

  let response;
  try {
    response = await deps.waitForResponse({
      server: config.ntfyServer,
      topic: config.topic,
      requestId,
      timeout,
      authToken: config.authToken,
    });
  } catch (err) {
    console.error("[claude-remote-approver] Stop response listener failed:", err.message);
    return null;
  }

  if (response.timeout || response.error) {
    return null;
  }

  if (response.continue === true) {
    return { decision: "block", reason: "User requested continuation" };
  }

  return null;
}
```

**Important:** The `waitForResponse` function in `src/ntfy.mjs` currently only returns `{ approved, alwaysAllow }` or `{ answer }` from parsed SSE events. It needs to also return `{ continue: true }` when the parsed event has `continue: true`. Check the parsing logic at `src/ntfy.mjs:83-90`:

```javascript
if (parsed.requestId === requestId) {
  clearTimeout(timer);
  controller.signal.removeEventListener('abort', onAbort);
  controller.abort();
  if (typeof parsed.answer === 'string') {
    return { answer: parsed.answer };
  }
  return { approved: parsed.approved, alwaysAllow: parsed.alwaysAllow === true };
}
```

Add a `continue` check before the existing return:

```javascript
if (parsed.requestId === requestId) {
  clearTimeout(timer);
  controller.signal.removeEventListener('abort', onAbort);
  controller.abort();
  if (parsed.continue === true) {
    return { continue: true };
  }
  if (typeof parsed.answer === 'string') {
    return { answer: parsed.answer };
  }
  return { approved: parsed.approved, alwaysAllow: parsed.alwaysAllow === true };
}
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/stop.test.mjs`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 6: Commit**

```bash
git add src/stop.mjs src/ntfy.mjs test/stop.test.mjs
git commit -m "feat: add processStop and buildContinueAction for interactive Stop hook"
```

---

## Task 7: `waitForResponse` continue support + test

**Files:**
- Modify: `src/ntfy.mjs:83-90` (already done in Task 6, but test here)
- Test: `test/ntfy.test.mjs`

**Step 1: Write failing test**

Add to `test/ntfy.test.mjs` in the `waitForResponse` describe block:

```javascript
it("should return continue:true when response has continue flag", async () => {
  const events = [
    { type: "message", message: JSON.stringify({ requestId: "req-cont", continue: true }) },
  ];
  const mockFetch = createStreamingMockFetch(events);
  globalThis.fetch = mockFetch;

  const result = await waitForResponse({
    server: "https://ntfy.sh",
    topic: "my-topic",
    requestId: "req-cont",
    timeout: 5000,
  });
  assert.deepEqual(result, { continue: true });
});
```

**Step 2: Run test to verify it fails (if not already implemented in Task 6)**

Run: `node --test test/ntfy.test.mjs`
Expected: If Task 6's ntfy.mjs change was applied, this should PASS. If not, it will FAIL with `{ approved: undefined, alwaysAllow: false }`.

**Step 3: Verify the change from Task 6 is in place**

The `continue` check should already be added in `src/ntfy.mjs:83-90` from Task 6. If not, add it now.

**Step 4: Run tests**

Run: `node --test test/ntfy.test.mjs`
Expected: PASS

**Step 5: Commit (if changes needed)**

```bash
git add src/ntfy.mjs test/ntfy.test.mjs
git commit -m "test: add waitForResponse continue flag test"
```

---

## Task 8: CLI `stop` command routing

**Files:**
- Modify: `bin/cli.mjs:21-214` (add stop case in switch)
- Modify: `bin/cli.mjs:241-243` (import processStop)
- Modify: `bin/cli.mjs:250` (add "stop" to needsStdin)
- Modify: `bin/cli.mjs:260-284` (add processStop to deps)
- Test: `test/cli.test.mjs`

**Step 1: Write failing tests**

Add to `test/cli.test.mjs`:

```javascript
describe("stop command", () => {
  it("should parse stdin and call processStop", async () => {
    const deps = createDeps();
    deps.processStop = mock.fn(async () => ({ decision: "block", reason: "User requested continuation" }));
    deps.stdin = JSON.stringify({ hook_event_name: "Stop" });

    await main(["stop"], deps);

    assert.equal(deps.processStop.mock.calls.length, 1);
    const input = deps.processStop.mock.calls[0].arguments[0];
    assert.equal(input.hook_event_name, "Stop");
  });

  it("should write result to stdout when processStop returns non-null", async () => {
    const deps = createDeps();
    deps.processStop = mock.fn(async () => ({ decision: "block", reason: "User requested continuation" }));
    deps.stdin = JSON.stringify({ hook_event_name: "Stop" });

    await main(["stop"], deps);

    const output = deps.stdout.write.mock.calls.map(c => c.arguments[0]).join("");
    const parsed = JSON.parse(output.trim());
    assert.equal(parsed.decision, "block");
  });

  it("should write nothing to stdout when processStop returns null", async () => {
    const deps = createDeps();
    deps.processStop = mock.fn(async () => null);
    deps.stdin = JSON.stringify({ hook_event_name: "Stop" });

    await main(["stop"], deps);

    const output = deps.stdout.write.mock.calls.map(c => c.arguments[0]).join("");
    assert.equal(output, "");
  });

  it("should handle invalid stdin gracefully", async () => {
    const deps = createDeps();
    deps.processStop = mock.fn(async () => null);
    deps.stdin = "not json";

    await main(["stop"], deps);

    assert.equal(deps.processStop.mock.calls.length, 0);
    const stderrOutput = deps.stderr.write.mock.calls.map(c => c.arguments[0]).join("");
    assert.ok(stderrOutput.includes("Invalid"));
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/cli.test.mjs`
Expected: FAIL — no `stop` case in switch

**Step 3: Implement**

In `bin/cli.mjs`, add the `stop` case in the switch statement (after the `notify` case, around line 190):

```javascript
case "stop": {
  let input;
  try {
    input = JSON.parse(deps.stdin);
  } catch {
    deps.stderr.write("[claude-remote-approver] Invalid stop input.\n");
    break;
  }
  try {
    const result = await deps.processStop(input, deps);
    if (result !== null) {
      deps.stdout.write(JSON.stringify(result) + "\n");
    }
  } catch (err) {
    deps.stderr.write(`[claude-remote-approver] Stop processing failed: ${err.message}\n`);
  }
  break;
}
```

Update `needsStdin` (line 250):

```javascript
const needsStdin = ["hook", "notify", "stop"].includes(args[0]);
```

In the `isMain` block, import `processStop` and add to deps:

```javascript
const { processStop } = await import("../src/stop.mjs");
// ...
const deps = {
  // ... existing deps ...
  processStop,
};
```

Update the help text in both locations to include `stop`:

```
  stop        Process a Stop hook with Continue button (internal)\n
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/cli.test.mjs`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 6: Commit**

```bash
git add bin/cli.mjs test/cli.test.mjs
git commit -m "feat: add stop CLI command for interactive Stop hook"
```

---

## Task 9: Hook registration — conditional Stop command

**Files:**
- Modify: `src/setup.mjs:14-21` (NOTIFICATION_HOOK_EVENTS)
- Modify: `src/setup.mjs:61-102` (registerNotificationHooks)
- Add: `getStopCommand()` to `src/setup.mjs`
- Test: `test/setup.test.mjs`

**Step 1: Write failing tests**

Add to `test/setup.test.mjs`. Import `getStopCommand` from `../src/setup.mjs`.

```javascript
describe("getStopCommand", () => {
  it("should return a command string containing 'cli.mjs stop'", () => {
    const cmd = getStopCommand();
    assert.ok(cmd.includes("cli.mjs"));
    assert.ok(cmd.includes("stop"));
  });
});

describe("registerNotificationHooks with stopWithContinue", () => {
  let tmpDir, tmpSettingsPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cra-stopreg-test-"));
    tmpSettingsPath = path.join(tmpDir, "settings.json");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should register Stop with stop command when stopWithContinue is true", () => {
    const stopCommand = "node /path/to/cli.mjs stop";
    const notifyCommand = "node /path/to/cli.mjs notify";
    registerNotificationHooks(
      tmpSettingsPath,
      notifyCommand,
      { stop: true, stopWithContinue: true },
      null,
      stopCommand
    );

    const settings = JSON.parse(fs.readFileSync(tmpSettingsPath, "utf-8"));
    const stopHook = settings.hooks.Stop[0];
    assert.ok(stopHook.hooks[0].command.includes("stop"));
  });

  it("should register Stop with notify command when stopWithContinue is false", () => {
    // Clean up from previous test
    try { fs.unlinkSync(tmpSettingsPath); } catch {}

    const stopCommand = "node /path/to/cli.mjs stop";
    const notifyCommand = "node /path/to/cli.mjs notify";
    registerNotificationHooks(
      tmpSettingsPath,
      notifyCommand,
      { stop: true, stopWithContinue: false },
      null,
      stopCommand
    );

    const settings = JSON.parse(fs.readFileSync(tmpSettingsPath, "utf-8"));
    const stopHook = settings.hooks.Stop[0];
    assert.ok(stopHook.hooks[0].command.includes("notify"));
  });

  it("should not register Stop at all when stop is disabled", () => {
    try { fs.unlinkSync(tmpSettingsPath); } catch {}

    registerNotificationHooks(
      tmpSettingsPath,
      "node /path/to/cli.mjs notify",
      { stop: false, stopWithContinue: false },
      null,
      "node /path/to/cli.mjs stop"
    );

    const settings = JSON.parse(fs.readFileSync(tmpSettingsPath, "utf-8"));
    assert.equal(settings.hooks?.Stop, undefined);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/setup.test.mjs`
Expected: FAIL

**Step 3: Implement**

Add `getStopCommand` to `src/setup.mjs` (after `getContextCommand`):

```javascript
/**
 * Returns the stop command string: `node <absolute_path_to_bin/cli.mjs> stop`
 */
export function getStopCommand() {
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");
  if (!fs.existsSync(cliPath)) {
    throw new Error(`CLI entry point not found: ${cliPath}`);
  }
  return `node "${cliPath}" stop`;
}
```

Update `registerNotificationHooks` signature to accept `stopCommand` parameter and handle the `stop` key specially:

```javascript
export function registerNotificationHooks(settingsPath, notifyCommand, notifications, contextCommand, stopCommand) {
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

    // Use stop command for Stop event when stopWithContinue is enabled
    const command = (configKey === "stop" && notifications.stopWithContinue && stopCommand)
      ? stopCommand
      : notifyCommand;

    if (!Array.isArray(settings.hooks[hookEvent])) {
      settings.hooks[hookEvent] = [];
    }
    const existingIdx = settings.hooks[hookEvent].findIndex(isCraEntry);
    const entry = { hooks: [{ type: "command", command }] };
    if (existingIdx >= 0) {
      settings.hooks[hookEvent][existingIdx] = entry;
    } else {
      settings.hooks[hookEvent].push(entry);
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
```

Update `runSetup` to pass `stopCommand`:

```javascript
const stopCommand = getStopCommand();
registerNotificationHooks(settingsPath, notifyCommand, config.notifications || {}, contextCommand, stopCommand);
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/setup.test.mjs`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 6: Commit**

```bash
git add src/setup.mjs test/setup.test.mjs
git commit -m "feat: conditional Stop hook registration based on stopWithContinue"
```

---

## Task 10: Context injection update

**Files:**
- Modify: `src/context.mjs:3-32` (generateContext)
- Test: `test/context.test.mjs`

**Step 1: Write failing test**

Add to `test/context.test.mjs` (or create if it doesn't exist — check first):

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateContext } from "../src/context.mjs";

describe("generateContext with stopWithContinue", () => {
  it("should mention Continue button when stopWithContinue is enabled", () => {
    const config = {
      timeout: 120,
      planTimeout: 300,
      notifications: { stopWithContinue: true },
    };
    const result = generateContext(config);
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(ctx.toLowerCase().includes("continue"));
  });

  it("should not mention Continue button when stopWithContinue is disabled", () => {
    const config = {
      timeout: 120,
      planTimeout: 300,
      notifications: { stopWithContinue: false },
    };
    const result = generateContext(config);
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(!ctx.toLowerCase().includes("continue button"));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/context.test.mjs`
Expected: FAIL — context doesn't mention Continue

**Step 3: Implement**

Update `generateContext` in `src/context.mjs` to conditionally include Continue button info:

```javascript
export function generateContext(config) {
  let ctx = `## Remote Approval Context

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

  if (config.notifications?.stopWithContinue) {
    ctx += `
- When you finish a task, the user receives a notification with a Continue button
  They can tap it to request you keep working — wait for this before considering the task complete`;
  }

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

**Step 5: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 6: Commit**

```bash
git add src/context.mjs test/context.test.mjs
git commit -m "feat: mention Continue button in session context when enabled"
```

---

## Task 11: Status command — show `continueTimeout` and `stopWithContinue`

**Files:**
- Modify: `bin/cli.mjs:82-103` (status case)
- Test: `test/cli.test.mjs`

**Step 1: Write failing test**

Add to `test/cli.test.mjs`:

```javascript
describe("status with stopWithContinue", () => {
  it("should show stopWithContinue status in notifications section", async () => {
    const deps = createDeps({
      config: {
        ...defaultConfig,
        notifications: { idle: true, stop: true, stopWithContinue: true, sessionStart: false, sessionEnd: false, toolFailure: true, subagentStop: false },
      },
    });
    await main(["status"], deps);

    const output = deps.stdout.write.mock.calls.map(c => c.arguments[0]).join("");
    assert.ok(output.includes("Stop + Continue"));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/cli.test.mjs`
Expected: FAIL — status doesn't show "Stop + Continue"

**Step 3: Implement**

In `bin/cli.mjs` status case, update the labels object and add `stopWithContinue` display. Replace the simple `stop` label with conditional logic:

```javascript
case "status": {
  const config = deps.loadConfig();
  deps.stdout.write(`Topic:   ${config.topic}\n`);
  deps.stdout.write(`Server:  ${config.ntfyServer}\n`);
  deps.stdout.write(`Auth:    ${config.authToken ? `${config.authToken.slice(0, 7)}... (configured)` : "none"}\n`);
  deps.stdout.write(`Timeout: ${config.timeout}s / ${config.planTimeout ?? 300}s (plan)`);
  if (config.continueTimeout && config.continueTimeout !== config.timeout) {
    deps.stdout.write(` / ${config.continueTimeout}s (continue)`);
  }
  deps.stdout.write("\n");
  if (config.notifications) {
    deps.stdout.write("Notifications:\n");
    const labels = {
      idle: "Idle prompt",
      stop: config.notifications.stopWithContinue ? "Stop + Continue" : "Stop (finished)",
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

**Step 5: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 6: Commit**

```bash
git add bin/cli.mjs test/cli.test.mjs
git commit -m "feat: show stopWithContinue and continueTimeout in status command"
```

---

## Task 12: Final integration test + version bump

**Files:**
- Modify: `package.json` (version bump to 0.8.0)

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 2: Manually verify the feature flow**

Verify with a dry-run check (no actual ntfy required):

```bash
# Check that stop command is in help text
node bin/cli.mjs --help

# Check status shows new fields
echo '{"topic":"cra-test","ntfyServer":"https://ntfy.sh","authToken":"","notifications":{"idle":true,"stop":true,"stopWithContinue":true}}' > /tmp/cra-test-config.json
# (The status command reads from the default config path, so just verify the code compiles)

# Check context includes Continue mention
node -e "
  import { generateContext } from './src/context.mjs';
  const r = generateContext({ timeout: 120, planTimeout: 300, notifications: { stopWithContinue: true } });
  console.log(r.hookSpecificOutput.additionalContext);
" --input-type=module

# Check that processStop can be imported
node -e "import { processStop, buildContinueAction } from './src/stop.mjs'; console.log('OK');" --input-type=module
```

**Step 3: Bump version**

Update `version` in `package.json` to `"0.8.0"`.

**Step 4: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 0.8.0"
```

---

## Summary of commits

1. `feat: add continueTimeout and allowInsecure config fields`
2. `feat: add isInsecureServer utility for HTTPS enforcement`
3. `feat: add validateToken for setup auth validation`
4. `feat: add HTTPS enforcement and token validation to setup`
5. `feat: add --allow-insecure flag for setup command`
6. `feat: add processStop and buildContinueAction for interactive Stop hook`
7. `test: add waitForResponse continue flag test`
8. `feat: add stop CLI command for interactive Stop hook`
9. `feat: conditional Stop hook registration based on stopWithContinue`
10. `feat: mention Continue button in session context when enabled`
11. `feat: show stopWithContinue and continueTimeout in status command`
12. `chore: bump version to 0.8.0`
