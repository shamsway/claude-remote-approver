/**
 * Test module for config.mjs
 *
 * Coverage:
 * - CONFIG_PATH uses home directory
 * - DEFAULT_CONFIG has correct shape and values
 * - loadConfig returns defaults when no file exists
 * - loadConfig merges partial config with defaults
 * - saveConfig writes valid JSON and loadConfig reads it back (round-trip)
 * - generateTopic returns string matching /^cra-[a-f0-9]{32}$/
 * - saveConfig writes file with mode 0o600
 * - loadConfig validates types and falls back to defaults for invalid values
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  generateTopic,
} from "../src/config.mjs";

// ==================== CONFIG_PATH ====================

describe("CONFIG_PATH", () => {
  it("should be a string ending with .claude-remote-approver.json", () => {
    assert.equal(typeof CONFIG_PATH, "string");
    assert.ok(
      CONFIG_PATH.endsWith(".claude-remote-approver.json"),
      `CONFIG_PATH should end with .claude-remote-approver.json, got: ${CONFIG_PATH}`
    );
  });

  it("should be located in the user home directory", () => {
    const home = os.homedir();
    assert.equal(
      CONFIG_PATH,
      path.join(home, ".claude-remote-approver.json"),
      `CONFIG_PATH should be ${path.join(home, ".claude-remote-approver.json")}, got: ${CONFIG_PATH}`
    );
  });
});

// ==================== DEFAULT_CONFIG ====================

describe("DEFAULT_CONFIG", () => {
  it("should be a plain object", () => {
    assert.equal(typeof DEFAULT_CONFIG, "object");
    assert.ok(DEFAULT_CONFIG !== null, "DEFAULT_CONFIG should not be null");
    assert.ok(!Array.isArray(DEFAULT_CONFIG), "DEFAULT_CONFIG should not be an array");
  });

  it("should have topic as empty string", () => {
    assert.equal(DEFAULT_CONFIG.topic, "");
  });

  it("should have ntfyServer as https://ntfy.sh", () => {
    assert.equal(DEFAULT_CONFIG.ntfyServer, "https://ntfy.sh");
  });

  it("should have timeout as 120", () => {
    assert.equal(DEFAULT_CONFIG.timeout, 120);
  });

  it("should have autoApprove as an empty array", () => {
    assert.ok(Array.isArray(DEFAULT_CONFIG.autoApprove), "autoApprove should be an array");
    assert.equal(DEFAULT_CONFIG.autoApprove.length, 0);
  });

  it("should have autoDeny as an empty array", () => {
    assert.ok(Array.isArray(DEFAULT_CONFIG.autoDeny), "autoDeny should be an array");
    assert.equal(DEFAULT_CONFIG.autoDeny.length, 0);
  });

  it("should have planTimeout as 300", () => {
    assert.equal(DEFAULT_CONFIG.planTimeout, 300);
  });

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
});

// ==================== loadConfig ====================

describe("loadConfig", () => {
  /** Use a temp directory to isolate filesystem tests. */
  let tmpDir;
  let tmpConfigPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cra-test-"));
    tmpConfigPath = path.join(tmpDir, ".claude-remote-approver.json");
  });

  after(() => {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be a function", () => {
    assert.equal(typeof loadConfig, "function");
  });

  it("should return defaults when config file does not exist", () => {
    const nonExistentPath = path.join(tmpDir, "no-such-file.json");
    const config = loadConfig(nonExistentPath);

    assert.deepEqual(config, {
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
    });
  });

  it("should merge partial config with defaults", () => {
    const partialConfig = { topic: "my-topic", timeout: 60 };
    fs.writeFileSync(tmpConfigPath, JSON.stringify(partialConfig, null, 2));

    const config = loadConfig(tmpConfigPath);

    // Overridden values
    assert.equal(config.topic, "my-topic");
    assert.equal(config.timeout, 60);

    // Default values preserved
    assert.equal(config.ntfyServer, "https://ntfy.sh");
    assert.deepEqual(config.autoApprove, []);
    assert.deepEqual(config.autoDeny, []);
  });

  it("should return a full config when file contains all fields", () => {
    const fullConfig = {
      topic: "full-topic",
      ntfyServer: "https://custom.ntfy.example.com",
      authToken: "tk_test123",
      timeout: 300,
      planTimeout: 600,
      autoApprove: ["Bash(*)"],
      autoDeny: ["mcp__*"],
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
    fs.writeFileSync(tmpConfigPath, JSON.stringify(fullConfig, null, 2));

    const config = loadConfig(tmpConfigPath);
    assert.deepEqual(config, fullConfig);
  });

  it("should fall back to default topic when topic is not a string", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ topic: 123 }));
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.topic, DEFAULT_CONFIG.topic);
  });

  it("should fall back to default ntfyServer when ntfyServer is not a string", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ ntfyServer: null }));
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.ntfyServer, DEFAULT_CONFIG.ntfyServer);
  });

  it("should fall back to default timeout when timeout is not a positive number", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ timeout: "fast" }));
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.timeout, DEFAULT_CONFIG.timeout);
  });

  it("should fall back to default timeout when timeout is zero or negative", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ timeout: 0 }));
    let config = loadConfig(tmpConfigPath);
    assert.equal(config.timeout, DEFAULT_CONFIG.timeout);

    fs.writeFileSync(tmpConfigPath, JSON.stringify({ timeout: -10 }));
    config = loadConfig(tmpConfigPath);
    assert.equal(config.timeout, DEFAULT_CONFIG.timeout);
  });

  it("should fall back to default autoApprove when autoApprove is not an array", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ autoApprove: "Bash(*)" }));
    const config = loadConfig(tmpConfigPath);
    assert.deepEqual(config.autoApprove, DEFAULT_CONFIG.autoApprove);
  });

  it("should fall back to default autoDeny when autoDeny is not an array", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ autoDeny: true }));
    const config = loadConfig(tmpConfigPath);
    assert.deepEqual(config.autoDeny, DEFAULT_CONFIG.autoDeny);
  });

  it("should fall back to default planTimeout when planTimeout is not a positive number", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ planTimeout: "slow" }));
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.planTimeout, DEFAULT_CONFIG.planTimeout);
  });

  it("should fall back to default planTimeout when planTimeout is zero or negative", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ planTimeout: 0 }));
    let config = loadConfig(tmpConfigPath);
    assert.equal(config.planTimeout, DEFAULT_CONFIG.planTimeout);

    fs.writeFileSync(tmpConfigPath, JSON.stringify({ planTimeout: -5 }));
    config = loadConfig(tmpConfigPath);
    assert.equal(config.planTimeout, DEFAULT_CONFIG.planTimeout);
  });

  it("should accept valid planTimeout from config file", () => {
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ planTimeout: 600 }));
    const config = loadConfig(tmpConfigPath);
    assert.equal(config.planTimeout, 600);
  });

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
});

// ==================== saveConfig ====================

describe("saveConfig", () => {
  let tmpDir;
  let tmpConfigPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cra-test-"));
    tmpConfigPath = path.join(tmpDir, ".claude-remote-approver.json");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should be a function", () => {
    assert.equal(typeof saveConfig, "function");
  });

  it("should write valid JSON to the specified path", () => {
    const config = {
      topic: "save-test",
      ntfyServer: "https://ntfy.sh",
      timeout: 120,
      autoApprove: [],
      autoDeny: [],
    };

    saveConfig(config, tmpConfigPath);

    const raw = fs.readFileSync(tmpConfigPath, "utf-8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed, config);
  });

  it("should write JSON with 2-space indentation", () => {
    const config = { topic: "indent-test", ntfyServer: "https://ntfy.sh" };

    saveConfig(config, tmpConfigPath);

    const raw = fs.readFileSync(tmpConfigPath, "utf-8");
    const expected = JSON.stringify(config, null, 2);
    assert.equal(raw, expected);
  });

  it("should round-trip with loadConfig", () => {
    const original = {
      topic: "roundtrip",
      ntfyServer: "https://custom.example.com",
      authToken: "",
      timeout: 90,
      planTimeout: 180,
      autoApprove: ["Read"],
      autoDeny: ["Bash(rm*)"],
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

    saveConfig(original, tmpConfigPath);
    const loaded = loadConfig(tmpConfigPath);

    assert.deepEqual(loaded, original);
  });

  it("should write file with mode 0o600 (owner read/write only)", () => {
    const config = { topic: "perm-test" };
    saveConfig(config, tmpConfigPath);

    const stat = fs.statSync(tmpConfigPath);
    const mode = stat.mode & 0o777;
    assert.equal(
      mode,
      0o600,
      `File mode should be 0o600, got 0o${mode.toString(8)}`
    );
  });
});

// ==================== generateTopic ====================

describe("generateTopic", () => {
  it("should be a function", () => {
    assert.equal(typeof generateTopic, "function");
  });

  it("should return a string", () => {
    const topic = generateTopic();
    assert.equal(typeof topic, "string");
  });

  it("should start with 'cra-' prefix", () => {
    const topic = generateTopic();
    assert.ok(topic.startsWith("cra-"), `Topic should start with 'cra-', got: ${topic}`);
  });

  it("should match pattern /^cra-[a-f0-9]{32}$/", () => {
    const topic = generateTopic();
    const pattern = /^cra-[a-f0-9]{32}$/;
    assert.match(topic, pattern, `Topic should match ${pattern}, got: ${topic}`);
  });

  it("should generate unique values on successive calls", () => {
    const topics = new Set();
    for (let i = 0; i < 20; i++) {
      topics.add(generateTopic());
    }
    assert.equal(topics.size, 20, "All 20 generated topics should be unique");
  });
});
