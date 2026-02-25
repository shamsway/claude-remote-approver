/**
 * Test suite for bin/cli.mjs
 *
 * Coverage:
 * - main(['setup'], deps) — calls runSetup with correct params
 * - main(['test'], deps) — loads config, sends test notification
 * - main(['test'], deps) — reports error when no topic configured
 * - main(['status'], deps) — loads config, writes settings to stdout
 * - main(['hook'], deps) — reads JSON from stdin, calls processHook, writes result to stdout
 * - main([], deps) / unknown command — writes help/usage to stderr
 * - main(['hook'], deps) — outputs valid JSON for allow decision
 * - main(['hook'], deps) — outputs valid JSON for deny decision
 * - main(['uninstall'], deps) — unregisters hook, deletes config, handles ENOENT
 * - main(['disable'], deps) — unregisters hook WITHOUT deleting config
 * - main(['enable'], deps) — loads config, registers hook when topic exists
 *
 * TDD Red phase — all tests must FAIL because main is undefined (stub).
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { main } from "../bin/cli.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock stdout/stderr object that collects written strings.
 */
function createMockWriter() {
  const chunks = [];
  return {
    write(str) {
      chunks.push(str);
    },
    /** Returns all written output concatenated. */
    output() {
      return chunks.join("");
    },
    chunks,
  };
}

/**
 * Creates a full set of injected dependencies with sensible defaults.
 * Override individual entries as needed per test.
 */
function createDeps(overrides = {}) {
  const defaultConfig = {
    topic: "test-topic-abc",
    ntfyServer: "https://ntfy.sh",
    timeout: 120,
    autoApprove: [],
    autoDeny: [],
  };

  return {
    loadConfig: mock.fn(() => overrides.config ?? defaultConfig),
    saveConfig: mock.fn(() => {}),
    generateTopic: mock.fn(() => "cra-generated123"),
    sendNotification: mock.fn(async () => ({ ok: true, status: 200 })),
    waitForResponse: mock.fn(
      async () => overrides.waitResult ?? { approved: true },
    ),
    formatToolInfo: mock.fn(
      () =>
        overrides.toolInfo ?? {
          title: "Claude Code: Bash",
          message: "echo hello",
        },
    ),
    processHook: mock.fn(
      async () =>
        overrides.hookResult ?? {
          hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
        },
    ),
    processNotify: mock.fn(async () => {}),
    processStop: mock.fn(async () => null),
    generateContext: mock.fn(() => ({
      hookSpecificOutput: { additionalContext: "Remote approval context..." },
    })),
    runSetup: mock.fn(
      async () =>
        overrides.setupResult ?? {
          topic: "cra-generated123",
          ntfyServer: "https://ntfy.sh",
          configPath: "/home/user/.claude-remote-approver.json",
          settingsPath: "/home/user/.claude/settings.json",
        },
    ),
    unregisterAllHooks: mock.fn(() => {}),
    version: overrides.version ?? pkg.version,
    generateQR: overrides.generateQR ?? mock.fn((text, opts, cb) => cb("")),
    stdout: overrides.stdout ?? createMockWriter(),
    stderr: overrides.stderr ?? createMockWriter(),
    stdin: overrides.stdin ?? "",
    exit: mock.fn(() => {}),
    ...overrides,
  };
}

// ===========================================================================
// main — type check
// ===========================================================================

describe("main", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof main, "function");
  });

  // =========================================================================
  // setup subcommand
  // =========================================================================

  describe("setup subcommand", () => {
    it("should call runSetup when args is ['setup']", async () => {
      const deps = createDeps();

      await main(["setup"], deps);

      assert.equal(
        deps.runSetup.mock.callCount(),
        1,
        "runSetup should be called exactly once",
      );
    });

    it("should write the generated topic to stdout after setup", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });

      await main(["setup"], deps);

      const output = stdout.output();
      assert.ok(
        output.includes("cra-generated123"),
        `stdout should contain the topic, got: ${output}`,
      );
    });

    it("should call generateQR with ntfy:// URL containing the topic", async () => {
      const deps = createDeps();
      await main(["setup"], deps);

      assert.equal(deps.generateQR.mock.callCount(), 1, "generateQR should be called exactly once");
      const [text] = deps.generateQR.mock.calls[0].arguments;
      assert.equal(text, "ntfy://ntfy.sh/cra-generated123", `QR text should be ntfy:// URL, got: ${text}`);
    });

    it("should write QR output from generateQR callback to stdout", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        generateQR: mock.fn((text, opts, cb) => cb("FAKE_QR_OUTPUT")),
      });
      await main(["setup"], deps);

      const output = stdout.output();
      assert.ok(output.includes("FAKE_QR_OUTPUT"), `stdout should contain QR output, got: ${output}`);
    });

    it("should write https:// subscribe URL to stdout", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });
      await main(["setup"], deps);

      const output = stdout.output();
      assert.ok(
        output.includes("https://ntfy.sh/cra-generated123"),
        `stdout should contain https subscribe URL, got: ${output}`,
      );
    });

    it("should use custom ntfyServer host in QR URL when server is not ntfy.sh", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        setupResult: {
          topic: "cra-custom123",
          ntfyServer: "https://ntfy.example.com",
          configPath: "/home/user/.claude-remote-approver.json",
          settingsPath: "/home/user/.claude/settings.json",
        },
      });
      await main(["setup"], deps);

      assert.equal(deps.generateQR.mock.callCount(), 1);
      const [text] = deps.generateQR.mock.calls[0].arguments;
      assert.equal(text, "ntfy://ntfy.example.com/cra-custom123", `QR text should use custom host, got: ${text}`);

      const output = stdout.output();
      assert.ok(
        output.includes("https://ntfy.example.com/cra-custom123"),
        `stdout should contain custom https URL, got: ${output}`,
      );
    });

    it("should use http:// URL in QR code when ntfyServer is HTTP", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        setupResult: {
          topic: "cra-selfhost123",
          ntfyServer: "http://192.168.1.100:8080",
          configPath: "/home/user/.claude-remote-approver.json",
          settingsPath: "/home/user/.claude/settings.json",
        },
      });
      await main(["setup"], deps);

      assert.equal(deps.generateQR.mock.callCount(), 1);
      const [text] = deps.generateQR.mock.calls[0].arguments;
      assert.equal(text, "http://192.168.1.100:8080/cra-selfhost123", `QR text should use http:// for HTTP server, got: ${text}`);

      const output = stdout.output();
      assert.ok(
        output.includes("http://192.168.1.100:8080/cra-selfhost123"),
        `stdout should contain http subscribe URL, got: ${output}`,
      );
    });

    it("should handle invalid ntfyServer URL gracefully without crashing", async () => {
      const stdout = createMockWriter();
      const stderr = createMockWriter();
      const deps = createDeps({
        stdout,
        stderr,
        setupResult: {
          topic: "cra-invalidurl123",
          ntfyServer: "not-a-valid-url",
          configPath: "/home/user/.claude-remote-approver.json",
          settingsPath: "/home/user/.claude/settings.json",
        },
      });

      // Should not throw
      await assert.doesNotReject(async () => {
        await main(["setup"], deps);
      });

      const errOutput = stderr.output();
      assert.ok(
        errOutput.includes("Warning") && errOutput.includes("not-a-valid-url"),
        `stderr should contain a warning about the invalid URL, got: ${errOutput}`,
      );

      const output = stdout.output();
      assert.ok(output.includes("cra-invalidurl123"), `stdout should still contain the topic, got: ${output}`);
    });
  });

  // =========================================================================
  // test subcommand
  // =========================================================================

  describe("test subcommand", () => {
    it("should load config and call sendNotification with a test message", async () => {
      const deps = createDeps();

      await main(["test"], deps);

      assert.equal(
        deps.loadConfig.mock.callCount(),
        1,
        "loadConfig should be called once",
      );
      assert.equal(
        deps.sendNotification.mock.callCount(),
        1,
        "sendNotification should be called once",
      );

      const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
      assert.equal(callArgs.topic, "test-topic-abc");
      assert.equal(callArgs.server, "https://ntfy.sh");
    });

    it("should write error to stderr when sendNotification throws", async () => {
      const stdout = createMockWriter();
      const stderr = createMockWriter();
      const deps = createDeps({
        stdout,
        stderr,
        sendNotification: mock.fn(async () => {
          throw new Error("network timeout");
        }),
      });

      await main(["test"], deps);

      const errOutput = stderr.output();
      assert.ok(
        errOutput.includes("Failed to send notification"),
        `stderr should contain failure message, got: ${errOutput}`,
      );
      assert.ok(
        errOutput.includes("network timeout"),
        `stderr should contain the error message, got: ${errOutput}`,
      );
      assert.equal(
        stdout.output().includes("sent successfully"),
        false,
        "stdout should NOT contain success message when notification fails",
      );
    });

    it("should report error to stderr when config has no topic", async () => {
      const stderr = createMockWriter();
      const noTopicConfig = {
        topic: "",
        ntfyServer: "https://ntfy.sh",
        timeout: 120,
        autoApprove: [],
        autoDeny: [],
      };
      const deps = createDeps({ config: noTopicConfig, stderr });

      await main(["test"], deps);

      const output = stderr.output();
      assert.ok(
        output.length > 0,
        "stderr should contain an error message when topic is empty",
      );
      assert.equal(
        deps.sendNotification.mock.callCount(),
        0,
        "sendNotification should NOT be called when topic is empty",
      );
    });
  });

  // =========================================================================
  // status subcommand
  // =========================================================================

  describe("status subcommand", () => {
    it("should load config and write settings to stdout", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });

      await main(["status"], deps);

      assert.equal(
        deps.loadConfig.mock.callCount(),
        1,
        "loadConfig should be called once",
      );

      const output = stdout.output();
      assert.ok(
        output.includes("test-topic-abc"),
        `stdout should contain the topic, got: ${output}`,
      );
      assert.ok(
        output.includes("https://ntfy.sh"),
        `stdout should contain the server URL, got: ${output}`,
      );
    });

    it("should show auth status when authToken is configured", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        config: {
          topic: "cra-abc",
          ntfyServer: "https://ntfy.example.com",
          timeout: 120,
          planTimeout: 300,
          authToken: "tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2",
          notifications: { idle: true, stop: true, sessionStart: false, sessionEnd: false, toolFailure: true, subagentStop: false, stopWithContinue: false },
        },
      });

      await main(["status"], deps);

      const output = stdout.output();
      assert.ok(output.includes("Auth:"), `should show Auth line, got: ${output}`);
      assert.ok(output.includes("configured"), `should show auth configured, got: ${output}`);
    });

    it("should show 'none' for auth when no authToken is configured", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        config: {
          topic: "cra-abc",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
          planTimeout: 300,
          authToken: "",
          notifications: { idle: true, stop: true, sessionStart: false, sessionEnd: false, toolFailure: true, subagentStop: false, stopWithContinue: false },
        },
      });

      await main(["status"], deps);

      const output = stdout.output();
      assert.ok(output.includes("none"), `should show auth none, got: ${output}`);
    });

    it("should show notification status", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        config: {
          topic: "cra-abc",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
          planTimeout: 300,
          authToken: "",
          notifications: { idle: true, stop: true, sessionStart: false, sessionEnd: false, toolFailure: true, subagentStop: false, stopWithContinue: false },
        },
      });

      await main(["status"], deps);

      const output = stdout.output();
      assert.ok(output.includes("Notifications:"), `should show Notifications section, got: ${output}`);
      assert.ok(output.includes("Idle prompt"), `should list idle notification, got: ${output}`);
      assert.ok(output.includes("Tool failure"), `should list tool failure notification, got: ${output}`);
    });

    it("should show plan timeout in status", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        config: {
          topic: "cra-abc",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
          planTimeout: 300,
          authToken: "",
          notifications: {},
        },
      });

      await main(["status"], deps);

      const output = stdout.output();
      assert.ok(output.includes("300s"), `should show plan timeout, got: ${output}`);
    });

    it("should show 'Stop + Continue' when stopWithContinue is true", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        config: {
          topic: "cra-abc",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
          planTimeout: 300,
          authToken: "",
          notifications: { idle: true, stop: true, sessionStart: false, sessionEnd: false, toolFailure: true, subagentStop: false, stopWithContinue: true },
        },
      });

      await main(["status"], deps);

      const output = stdout.output();
      assert.ok(output.includes("Stop + Continue"), `should show 'Stop + Continue', got: ${output}`);
      assert.ok(!output.includes("Stop (finished)"), `should NOT show 'Stop (finished)' when stopWithContinue is true, got: ${output}`);
    });

    it("should show 'Stop (finished)' when stopWithContinue is false", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        config: {
          topic: "cra-abc",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
          planTimeout: 300,
          authToken: "",
          notifications: { idle: true, stop: true, sessionStart: false, sessionEnd: false, toolFailure: true, subagentStop: false, stopWithContinue: false },
        },
      });

      await main(["status"], deps);

      const output = stdout.output();
      assert.ok(output.includes("Stop (finished)"), `should show 'Stop (finished)' when stopWithContinue is false, got: ${output}`);
      assert.ok(!output.includes("Stop + Continue"), `should NOT show 'Stop + Continue' when stopWithContinue is false, got: ${output}`);
    });

    it("should show continueTimeout when it differs from timeout", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        config: {
          topic: "cra-abc",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
          planTimeout: 300,
          continueTimeout: 45,
          authToken: "",
          notifications: {},
        },
      });

      await main(["status"], deps);

      const output = stdout.output();
      assert.ok(output.includes("45s (continue)"), `should show continueTimeout, got: ${output}`);
    });

    it("should NOT show continueTimeout when it equals timeout", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        config: {
          topic: "cra-abc",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
          planTimeout: 300,
          continueTimeout: 120,
          authToken: "",
          notifications: {},
        },
      });

      await main(["status"], deps);

      const output = stdout.output();
      assert.ok(!output.includes("(continue)"), `should NOT show continueTimeout when it equals timeout, got: ${output}`);
    });

    it("should NOT show continueTimeout when it is not set", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        config: {
          topic: "cra-abc",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
          planTimeout: 300,
          authToken: "",
          notifications: {},
        },
      });

      await main(["status"], deps);

      const output = stdout.output();
      assert.ok(!output.includes("(continue)"), `should NOT show continueTimeout when not set, got: ${output}`);
    });
  });

  // =========================================================================
  // hook subcommand
  // =========================================================================

  describe("hook subcommand", () => {
    it("should read JSON from stdin, call processHook, and write result to stdout", async () => {
      const hookInput = {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
      };
      const stdout = createMockWriter();
      const deps = createDeps({
        stdin: JSON.stringify(hookInput),
        stdout,
      });

      await main(["hook"], deps);

      assert.equal(
        deps.processHook.mock.callCount(),
        1,
        "processHook should be called exactly once",
      );

      // Verify the input passed to processHook
      const callArgs = deps.processHook.mock.calls[0].arguments[0];
      assert.equal(callArgs.tool_name, "Bash");
      assert.deepEqual(callArgs.tool_input, { command: "ls -la" });
    });

    it("should output valid JSON for allow decision", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdin: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "echo allowed" },
        }),
        stdout,
        hookResult: {
          hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
        },
      });

      await main(["hook"], deps);

      const output = stdout.output();
      assert.ok(output.endsWith("\n"), "hook output should end with a newline");
      const parsed = JSON.parse(output);
      assert.equal(parsed.hookSpecificOutput.decision.behavior, "allow");
    });

    it("should output valid JSON for deny decision", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdin: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "rm -rf /" },
        }),
        stdout,
        hookResult: {
          hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } },
        },
      });

      await main(["hook"], deps);

      const output = stdout.output();
      assert.ok(output.endsWith("\n"), "hook output should end with a newline");
      const parsed = JSON.parse(output);
      assert.equal(parsed.hookSpecificOutput.decision.behavior, "deny");
    });

    it("should output ask JSON when stdin contains malformed JSON", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdin: "this is not valid json{{{",
        stdout,
      });

      await main(["hook"], deps);

      const output = stdout.output();
      assert.ok(output.endsWith("\n"), "hook output should end with a newline");
      const parsed = JSON.parse(output);
      assert.equal(parsed.hookSpecificOutput.decision.behavior, "ask");
      assert.equal(parsed.hookSpecificOutput.hookEventName, "PermissionRequest");
      assert.equal(
        deps.processHook.mock.callCount(),
        0,
        "processHook should NOT be called when JSON parsing fails",
      );
    });

    it("should output ask JSON when processHook throws an error", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdin: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "ls" },
        }),
        stdout,
        processHook: mock.fn(async () => {
          throw new Error("processHook failed");
        }),
      });

      await main(["hook"], deps);

      const output = stdout.output();
      assert.ok(output.endsWith("\n"), "hook output should end with a newline");
      const parsed = JSON.parse(output);
      assert.equal(parsed.hookSpecificOutput.decision.behavior, "ask");
      assert.equal(parsed.hookSpecificOutput.hookEventName, "PermissionRequest");
    });

    it("should write fallback message to stderr when stdin contains malformed JSON", async () => {
      const stdout = createMockWriter();
      const stderr = createMockWriter();
      const deps = createDeps({
        stdin: "this is not valid json{{{",
        stdout,
        stderr,
      });

      await main(["hook"], deps);

      const errOutput = stderr.output();
      assert.ok(
        errOutput.includes("[claude-remote-approver]") && errOutput.includes("Invalid hook input"),
        `stderr should contain prefixed fallback message, got: ${errOutput}`,
      );
    });

    it("should write fallback message to stderr when processHook throws an error", async () => {
      const stdout = createMockWriter();
      const stderr = createMockWriter();
      const deps = createDeps({
        stdin: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "ls" },
        }),
        stdout,
        stderr,
        processHook: mock.fn(async () => {
          throw new Error("processHook failed");
        }),
      });

      await main(["hook"], deps);

      const errOutput = stderr.output();
      assert.ok(
        errOutput.includes("[claude-remote-approver]") && errOutput.includes("Hook processing failed"),
        `stderr should contain prefixed fallback message, got: ${errOutput}`,
      );
    });
  });

  // =========================================================================
  // uninstall subcommand
  // =========================================================================

  describe("uninstall subcommand", () => {
    it("should call unregisterAllHooks with settingsPath", async () => {
      const deps = createDeps({
        unregisterAllHooks: mock.fn(() => {}),
        settingsPath: "/fake/settings.json",
        unlinkSync: mock.fn(() => {}),
        configPath: "/fake/config.json",
      });

      await main(["uninstall"], deps);

      assert.equal(
        deps.unregisterAllHooks.mock.callCount(),
        1,
        "unregisterAllHooks should be called exactly once",
      );
      assert.equal(
        deps.unregisterAllHooks.mock.calls[0].arguments[0],
        "/fake/settings.json",
        "unregisterAllHooks should be called with settingsPath",
      );
    });

    it("should delete config file via unlinkSync", async () => {
      const deps = createDeps({
        unregisterAllHooks: mock.fn(() => {}),
        settingsPath: "/fake/settings.json",
        unlinkSync: mock.fn(() => {}),
        configPath: "/fake/config.json",
      });

      await main(["uninstall"], deps);

      assert.equal(
        deps.unlinkSync.mock.callCount(),
        1,
        "unlinkSync should be called exactly once",
      );
      assert.equal(
        deps.unlinkSync.mock.calls[0].arguments[0],
        "/fake/config.json",
        "unlinkSync should be called with configPath",
      );
    });

    it("should ignore ENOENT when config file does not exist", async () => {
      const deps = createDeps({
        unregisterAllHooks: mock.fn(() => {}),
        settingsPath: "/fake/settings.json",
        unlinkSync: mock.fn(() => {
          const err = new Error("ENOENT");
          err.code = "ENOENT";
          throw err;
        }),
        configPath: "/fake/config.json",
      });

      // Should not throw
      await assert.doesNotReject(async () => {
        await main(["uninstall"], deps);
      });
    });

    it("should write completion message to stdout", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        unregisterAllHooks: mock.fn(() => {}),
        settingsPath: "/fake/settings.json",
        unlinkSync: mock.fn(() => {}),
        configPath: "/fake/config.json",
      });

      await main(["uninstall"], deps);

      const output = stdout.output();
      assert.ok(
        output.length > 0,
        "stdout should contain a completion message",
      );
      assert.ok(
        !output.toLowerCase().includes("error"),
        `stdout should not contain error messages, got: ${output}`,
      );
    });
  });

  // =========================================================================
  // disable subcommand
  // =========================================================================

  describe("disable subcommand", () => {
    it("should call unregisterAllHooks with settingsPath", async () => {
      const deps = createDeps({
        unregisterAllHooks: mock.fn(() => {}),
        settingsPath: "/fake/settings.json",
        unlinkSync: mock.fn(() => {}),
        configPath: "/fake/config.json",
      });

      await main(["disable"], deps);

      assert.equal(
        deps.unregisterAllHooks.mock.callCount(),
        1,
        "unregisterAllHooks should be called exactly once",
      );
      assert.equal(
        deps.unregisterAllHooks.mock.calls[0].arguments[0],
        "/fake/settings.json",
        "unregisterAllHooks should be called with settingsPath",
      );
    });

    it("should NOT delete config file", async () => {
      const deps = createDeps({
        unregisterAllHooks: mock.fn(() => {}),
        settingsPath: "/fake/settings.json",
        unlinkSync: mock.fn(() => {}),
        configPath: "/fake/config.json",
      });

      await main(["disable"], deps);

      assert.equal(
        deps.unlinkSync.mock.callCount(),
        0,
        "unlinkSync should NOT be called for disable (config is preserved)",
      );
    });

    it("should write completion message to stdout mentioning enable", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        unregisterAllHooks: mock.fn(() => {}),
        settingsPath: "/fake/settings.json",
        unlinkSync: mock.fn(() => {}),
        configPath: "/fake/config.json",
      });

      await main(["disable"], deps);

      const output = stdout.output().toLowerCase();
      assert.ok(
        output.includes("enable"),
        `stdout should mention 'enable' as a hint for re-enabling, got: ${stdout.output()}`,
      );
    });
  });

  // =========================================================================
  // enable subcommand
  // =========================================================================

  describe("enable subcommand", () => {
    it("should call registerHook and registerNotificationHooks when topic is configured", async () => {
      const deps = createDeps({
        loadConfig: mock.fn(() => ({
          topic: "cra-abc123",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
          notifications: { idle: true, stop: true, toolFailure: true },
        })),
        registerHook: mock.fn(() => {}),
        registerNotificationHooks: mock.fn(() => {}),
        getHookCommand: mock.fn(() => "node /path/hook.mjs"),
        getNotifyCommand: mock.fn(() => "node /path/notify.mjs"),
        getContextCommand: mock.fn(() => "node /path/context.mjs"),
        getStopCommand: mock.fn(() => "node /path/stop.mjs"),
        settingsPath: "/fake/settings.json",
      });

      await main(["enable"], deps);

      assert.equal(
        deps.registerHook.mock.callCount(),
        1,
        "registerHook should be called exactly once",
      );
      assert.equal(
        deps.registerHook.mock.calls[0].arguments[0],
        "/fake/settings.json",
        "registerHook first arg should be settingsPath",
      );
      assert.equal(
        deps.registerHook.mock.calls[0].arguments[1],
        "node /path/hook.mjs",
        "registerHook second arg should be the hook command",
      );

      assert.equal(
        deps.registerNotificationHooks.mock.callCount(),
        1,
        "registerNotificationHooks should be called exactly once",
      );
      const rnhArgs = deps.registerNotificationHooks.mock.calls[0].arguments;
      assert.equal(rnhArgs[0], "/fake/settings.json", "first arg should be settingsPath");
      assert.equal(rnhArgs[1], "node /path/notify.mjs", "second arg should be notify command");
      assert.deepEqual(rnhArgs[2], { idle: true, stop: true, toolFailure: true }, "third arg should be notifications config");
      assert.equal(rnhArgs[3], "node /path/context.mjs", "fourth arg should be context command");
      assert.equal(rnhArgs[4], "node /path/stop.mjs", "fifth arg should be stop command");
    });

    it("should write error to stderr when no topic is configured", async () => {
      const stdout = createMockWriter();
      const stderr = createMockWriter();
      const deps = createDeps({
        stdout,
        stderr,
        loadConfig: mock.fn(() => ({
          topic: "",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
        })),
        registerHook: mock.fn(() => {}),
        registerNotificationHooks: mock.fn(() => {}),
        getHookCommand: mock.fn(() => "node /path/hook.mjs"),
        getNotifyCommand: mock.fn(() => "node /path/notify.mjs"),
        getContextCommand: mock.fn(() => "node /path/context.mjs"),
        getStopCommand: mock.fn(() => "node /path/stop.mjs"),
        settingsPath: "/fake/settings.json",
      });

      await main(["enable"], deps);

      assert.equal(
        deps.registerHook.mock.callCount(),
        0,
        "registerHook should NOT be called when topic is empty",
      );

      const errOutput = stderr.output();
      assert.ok(
        errOutput.length > 0,
        `stderr should contain an error message when topic is empty, got: ${errOutput}`,
      );
    });

    it("should write completion message to stdout on success", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        loadConfig: mock.fn(() => ({
          topic: "cra-abc123",
          ntfyServer: "https://ntfy.sh",
          timeout: 120,
          notifications: { idle: true },
        })),
        registerHook: mock.fn(() => {}),
        registerNotificationHooks: mock.fn(() => {}),
        getHookCommand: mock.fn(() => "node /path/hook.mjs"),
        getNotifyCommand: mock.fn(() => "node /path/notify.mjs"),
        getContextCommand: mock.fn(() => "node /path/context.mjs"),
        getStopCommand: mock.fn(() => "node /path/stop.mjs"),
        settingsPath: "/fake/settings.json",
      });

      await main(["enable"], deps);

      const output = stdout.output();
      assert.ok(
        output.length > 0,
        `stdout should contain a completion message, got: ${output}`,
      );
    });
  });

  // =========================================================================
  // --help and --version flags
  // =========================================================================

  describe("--help and --version flags", () => {
    it("should output usage to stdout when --help is passed", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });

      await main(["--help"], deps);

      const output = stdout.output();
      assert.ok(
        output.includes("Usage:"),
        `stdout should contain usage text, got: ${output}`,
      );
      assert.ok(
        output.includes("setup"),
        `stdout should mention setup command, got: ${output}`,
      );
      assert.equal(
        deps.exit.mock.callCount(),
        0,
        "exit should NOT be called for --help",
      );
    });

    it("should output usage to stdout when -h is passed", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });

      await main(["-h"], deps);

      const output = stdout.output();
      assert.ok(
        output.includes("Usage:"),
        `stdout should contain usage text for -h, got: ${output}`,
      );
    });

    it("should output version to stdout when --version is passed", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });

      await main(["--version"], deps);

      const output = stdout.output().trim();
      assert.ok(/^\d+\.\d+\.\d+$/.test(output), `should output a semver version, got: ${output}`);
    });

    it("should output version to stdout when -v is passed", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });

      await main(["-v"], deps);

      const output = stdout.output().trim();
      assert.ok(/^\d+\.\d+\.\d+$/.test(output), `should output a semver version, got: ${output}`);
    });

    it("should output version that matches package.json", async () => {
      const { readFileSync } = await import("node:fs");
      const { resolve, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

      const stdout = createMockWriter();
      const deps = createDeps({ stdout });
      await main(["--version"], deps);

      const output = stdout.output().trim();
      assert.equal(output, pkg.version, `CLI version should match package.json version, got: ${output}`);
    });

    it("should include enable, disable, and uninstall in help text", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({ stdout });

      await main(["--help"], deps);

      const output = stdout.output();
      assert.ok(
        output.includes("enable"),
        `help text should mention 'enable', got: ${output}`,
      );
      assert.ok(
        output.includes("disable"),
        `help text should mention 'disable', got: ${output}`,
      );
      assert.ok(
        output.includes("uninstall"),
        `help text should mention 'uninstall', got: ${output}`,
      );
    });
  });

  // =========================================================================
  // notify subcommand
  // =========================================================================

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
        processNotify: mock.fn(async () => { throw new Error("notify failed"); }),
      });

      await assert.doesNotReject(async () => {
        await main(["notify"], deps);
      });
    });
  });

  // =========================================================================
  // stop subcommand
  // =========================================================================

  describe("stop subcommand", () => {
    it("should parse stdin JSON and call processStop", async () => {
      const stopInput = { hook_event_name: "Stop", session_id: "abc123" };
      const processStop = mock.fn(async () => null);
      const deps = createDeps({
        stdin: JSON.stringify(stopInput),
        processStop,
      });

      await main(["stop"], deps);

      assert.equal(processStop.mock.callCount(), 1, "processStop should be called exactly once");
      const callArgs = processStop.mock.calls[0].arguments[0];
      assert.equal(callArgs.hook_event_name, "Stop");
      assert.equal(callArgs.session_id, "abc123");
    });

    it("should write JSON result to stdout when processStop returns non-null", async () => {
      const stdout = createMockWriter();
      const stopResult = { decision: "block", reason: "User requested continuation" };
      const deps = createDeps({
        stdin: JSON.stringify({ hook_event_name: "Stop" }),
        stdout,
        processStop: mock.fn(async () => stopResult),
      });

      await main(["stop"], deps);

      const output = stdout.output();
      assert.ok(output.length > 0, "stdout should have output when processStop returns non-null");
      assert.ok(output.endsWith("\n"), "output should end with a newline");
      const parsed = JSON.parse(output);
      assert.equal(parsed.decision, "block");
      assert.equal(parsed.reason, "User requested continuation");
    });

    it("should write nothing to stdout when processStop returns null", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdin: JSON.stringify({ hook_event_name: "Stop" }),
        stdout,
        processStop: mock.fn(async () => null),
      });

      await main(["stop"], deps);

      assert.equal(stdout.output(), "", "stdout should be empty when processStop returns null");
    });

    it("should write error to stderr and not call processStop when stdin is invalid JSON", async () => {
      const stderr = createMockWriter();
      const processStop = mock.fn(async () => null);
      const deps = createDeps({
        stdin: "not-valid-json{{{",
        stderr,
        processStop,
      });

      await main(["stop"], deps);

      const errOutput = stderr.output();
      assert.ok(
        errOutput.includes("[claude-remote-approver]") && errOutput.includes("Invalid stop input"),
        `stderr should contain prefixed error message, got: ${errOutput}`,
      );
      assert.equal(processStop.mock.callCount(), 0, "processStop should NOT be called when JSON parsing fails");
    });
  });

  // =========================================================================
  // context subcommand
  // =========================================================================

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

  // =========================================================================
  // prompt subcommand
  // =========================================================================

  describe("prompt subcommand", () => {
    it("should output the system prompt text to stdout", async () => {
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        generateContext: mock.fn(() => ({
          hookSpecificOutput: { additionalContext: "Remote Approval Context with push notification info" },
        })),
      });
      await main(["prompt"], deps);
      const output = stdout.output();
      assert.ok(output.includes("Remote Approval Context"));
      assert.ok(output.includes("push notification"));
    });
  });

  // =========================================================================
  // no args / unknown command
  // =========================================================================

  describe("no args or unknown command", () => {
    it("should write usage/help to stderr when called with no args", async () => {
      const stderr = createMockWriter();
      const deps = createDeps({ stderr });

      await main([], deps);

      const output = stderr.output();
      assert.ok(
        output.length > 0,
        "stderr should contain usage information when no args given",
      );
    });

    it("should write usage/help to stderr when called with unknown command", async () => {
      const stderr = createMockWriter();
      const deps = createDeps({ stderr });

      await main(["foobar"], deps);

      const output = stderr.output();
      assert.ok(
        output.length > 0,
        "stderr should contain usage information for unknown command",
      );
    });

    it("should call exit with non-zero code for unknown command", async () => {
      const deps = createDeps();

      await main(["unknown-cmd"], deps);

      assert.equal(
        deps.exit.mock.callCount(),
        1,
        "exit should be called once for unknown command",
      );
      assert.equal(
        deps.exit.mock.calls[0].arguments[0],
        1,
        "exit code should be 1",
      );
    });
  });

  // =========================================================================
  // setup --allow-insecure flag
  // =========================================================================

  describe("setup --allow-insecure flag", () => {
    it("should call runSetup when --allow-insecure is passed alongside setup", async () => {
      const deps = createDeps();

      await main(["setup", "--allow-insecure"], deps);

      assert.equal(
        deps.runSetup.mock.callCount(),
        1,
        "runSetup should be called exactly once when --allow-insecure is provided",
      );
    });

    it("should wrap loadConfig so returned config has allowInsecure: true when --allow-insecure is passed", async () => {
      let capturedDeps;
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        runSetup: mock.fn(async (d) => {
          capturedDeps = d;
          // Call the wrapped loadConfig and return a realistic result
          d.loadConfig();
          return {
            topic: "cra-generated123",
            ntfyServer: "https://ntfy.sh",
            configPath: "/home/user/.claude-remote-approver.json",
            settingsPath: "/home/user/.claude/settings.json",
          };
        }),
      });

      await main(["setup", "--allow-insecure"], deps);

      assert.ok(capturedDeps, "runSetup should have been called with a deps object");
      // The wrapped loadConfig should return config with allowInsecure: true
      const configResult = capturedDeps.loadConfig();
      assert.equal(
        configResult.allowInsecure,
        true,
        `loadConfig wrapped for --allow-insecure should return allowInsecure: true, got: ${configResult.allowInsecure}`,
      );
    });

    it("should pass validateToken to runSetup", async () => {
      let capturedDeps;
      const stdout = createMockWriter();
      const validateToken = mock.fn(async () => ({ valid: true }));
      const deps = createDeps({
        stdout,
        validateToken,
        runSetup: mock.fn(async (d) => {
          capturedDeps = d;
          return {
            topic: "cra-generated123",
            ntfyServer: "https://ntfy.sh",
            configPath: "/home/user/.claude-remote-approver.json",
            settingsPath: "/home/user/.claude/settings.json",
          };
        }),
      });

      await main(["setup"], deps);

      assert.ok(capturedDeps, "runSetup should have been called");
      assert.equal(
        capturedDeps.validateToken,
        validateToken,
        "runSetup should receive validateToken from deps",
      );
    });

    it("should pass stderr to runSetup", async () => {
      let capturedDeps;
      const stdout = createMockWriter();
      const stderr = createMockWriter();
      const deps = createDeps({
        stdout,
        stderr,
        runSetup: mock.fn(async (d) => {
          capturedDeps = d;
          return {
            topic: "cra-generated123",
            ntfyServer: "https://ntfy.sh",
            configPath: "/home/user/.claude-remote-approver.json",
            settingsPath: "/home/user/.claude/settings.json",
          };
        }),
      });

      await main(["setup"], deps);

      assert.ok(capturedDeps, "runSetup should have been called");
      assert.equal(
        capturedDeps.stderr,
        stderr,
        "runSetup should receive stderr from deps",
      );
    });

    it("should NOT set allowInsecure when --allow-insecure is not passed", async () => {
      let capturedDeps;
      const stdout = createMockWriter();
      const deps = createDeps({
        stdout,
        runSetup: mock.fn(async (d) => {
          capturedDeps = d;
          d.loadConfig();
          return {
            topic: "cra-generated123",
            ntfyServer: "https://ntfy.sh",
            configPath: "/home/user/.claude-remote-approver.json",
            settingsPath: "/home/user/.claude/settings.json",
          };
        }),
      });

      await main(["setup"], deps);

      assert.ok(capturedDeps, "runSetup should have been called");
      const configResult = capturedDeps.loadConfig();
      assert.notEqual(
        configResult.allowInsecure,
        true,
        "loadConfig should NOT set allowInsecure: true when --allow-insecure is not passed",
      );
    });
  });
});
