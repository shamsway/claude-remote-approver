/**
 * Test suite for src/stop.mjs
 *
 * Coverage:
 * - buildContinueAction: structure, URL, body, authToken
 * - processStop: config guards, send, response handling, timeout threading
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { buildContinueAction, processStop } from "../src/stop.mjs";

// ---------------------------------------------------------------------------
// buildContinueAction
// ---------------------------------------------------------------------------

describe("buildContinueAction", () => {
  it("should have label 'Continue'", () => {
    const action = buildContinueAction("https://ntfy.sh", "my-topic", "req-001");
    assert.equal(action.label, "Continue");
  });

  it("should have action type 'http'", () => {
    const action = buildContinueAction("https://ntfy.sh", "my-topic", "req-001");
    assert.equal(action.action, "http");
  });

  it("should set url to the response topic", () => {
    const action = buildContinueAction("https://ntfy.sh", "my-topic", "req-001");
    assert.equal(action.url, "https://ntfy.sh/my-topic-response");
  });

  it("should set method to POST", () => {
    const action = buildContinueAction("https://ntfy.sh", "my-topic", "req-001");
    assert.equal(action.method, "POST");
  });

  it("should set clear to true", () => {
    const action = buildContinueAction("https://ntfy.sh", "my-topic", "req-001");
    assert.equal(action.clear, true);
  });

  it("should include requestId and continue:true in body", () => {
    const action = buildContinueAction("https://ntfy.sh", "my-topic", "req-abc");
    const body = JSON.parse(action.body);
    assert.equal(body.requestId, "req-abc");
    assert.equal(body.continue, true);
  });

  it("should not include headers when authToken is not provided", () => {
    const action = buildContinueAction("https://ntfy.sh", "my-topic", "req-001");
    assert.equal(action.headers, undefined);
  });

  it("should not include headers when authToken is empty string", () => {
    const action = buildContinueAction("https://ntfy.sh", "my-topic", "req-001", { authToken: "" });
    assert.equal(action.headers, undefined);
  });

  it("should include Authorization header when authToken is provided", () => {
    const action = buildContinueAction("https://ntfy.sh", "my-topic", "req-001", { authToken: "tk_secret" });
    assert.ok(action.headers, "headers should be present");
    assert.equal(action.headers.Authorization, "Bearer tk_secret");
  });
});

// ---------------------------------------------------------------------------
// processStop
// ---------------------------------------------------------------------------

describe("processStop", () => {
  function makeDeps(overrides = {}) {
    return {
      loadConfig: mock.fn(() => ({
        topic: "my-topic",
        ntfyServer: "https://ntfy.sh",
        authToken: "",
        timeout: 120,
        continueTimeout: 60,
        notifications: { stopWithContinue: true },
      })),
      sendNotification: mock.fn(async () => ({ ok: true, status: 200 })),
      waitForResponse: mock.fn(async () => ({ continue: true })),
      ...overrides,
    };
  }

  it("should return null when topic is empty", async () => {
    const deps = makeDeps({
      loadConfig: mock.fn(() => ({
        topic: "",
        ntfyServer: "https://ntfy.sh",
        authToken: "",
        timeout: 120,
        continueTimeout: 60,
        notifications: { stopWithContinue: true },
      })),
    });
    const result = await processStop({}, deps);
    assert.equal(result, null);
  });

  it("should return null when stopWithContinue is false", async () => {
    const deps = makeDeps({
      loadConfig: mock.fn(() => ({
        topic: "my-topic",
        ntfyServer: "https://ntfy.sh",
        authToken: "",
        timeout: 120,
        continueTimeout: 60,
        notifications: { stopWithContinue: false },
      })),
    });
    const result = await processStop({}, deps);
    assert.equal(result, null);
  });

  it("should not send notification when stopWithContinue is false", async () => {
    const deps = makeDeps({
      loadConfig: mock.fn(() => ({
        topic: "my-topic",
        ntfyServer: "https://ntfy.sh",
        authToken: "",
        timeout: 120,
        continueTimeout: 60,
        notifications: { stopWithContinue: false },
      })),
    });
    await processStop({}, deps);
    assert.equal(deps.sendNotification.mock.calls.length, 0);
  });

  it("should send a notification with the Continue action button", async () => {
    const deps = makeDeps();
    await processStop({}, deps);

    assert.equal(deps.sendNotification.mock.calls.length, 1);
    const callArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.equal(callArgs.title, "Claude Code");
    assert.equal(callArgs.message, "Claude has finished responding");
    assert.equal(callArgs.priority, 3);
    assert.deepEqual(callArgs.tags, ["white_check_mark"]);
    assert.ok(Array.isArray(callArgs.actions), "actions should be an array");
    assert.equal(callArgs.actions.length, 1);
    assert.equal(callArgs.actions[0].label, "Continue");
  });

  it("should return block decision when response has continue:true", async () => {
    const deps = makeDeps({
      waitForResponse: mock.fn(async () => ({ continue: true })),
    });
    const result = await processStop({}, deps);
    assert.deepEqual(result, { decision: "block", reason: "User requested continuation" });
  });

  it("should return null on timeout", async () => {
    const deps = makeDeps({
      waitForResponse: mock.fn(async () => ({ timeout: true })),
    });
    const result = await processStop({}, deps);
    assert.equal(result, null);
  });

  it("should return null on error", async () => {
    const deps = makeDeps({
      waitForResponse: mock.fn(async () => ({ error: new Error("network fail") })),
    });
    const result = await processStop({}, deps);
    assert.equal(result, null);
  });

  it("should return null when send fails (sendWithRetry returns null)", async () => {
    const deps = makeDeps({
      sendNotification: mock.fn(async () => { throw new Error("send error"); }),
    });
    const result = await processStop({}, deps);
    assert.equal(result, null);
    // waitForResponse should not have been called
    assert.equal(deps.waitForResponse.mock.calls.length, 0);
  });

  it("should use continueTimeout for waitForResponse", async () => {
    const deps = makeDeps({
      loadConfig: mock.fn(() => ({
        topic: "my-topic",
        ntfyServer: "https://ntfy.sh",
        authToken: "",
        timeout: 120,
        continueTimeout: 60,
        notifications: { stopWithContinue: true },
      })),
    });
    await processStop({}, deps);

    const waitCall = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(waitCall.timeout, 60 * 1000);
  });

  it("should fall back to timeout when continueTimeout is unset", async () => {
    const deps = makeDeps({
      loadConfig: mock.fn(() => ({
        topic: "my-topic",
        ntfyServer: "https://ntfy.sh",
        authToken: "",
        timeout: 90,
        // continueTimeout deliberately absent
        notifications: { stopWithContinue: true },
      })),
    });
    await processStop({}, deps);

    const waitCall = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(waitCall.timeout, 90 * 1000);
  });

  it("should use default 120s when both continueTimeout and timeout are absent", async () => {
    const deps = makeDeps({
      loadConfig: mock.fn(() => ({
        topic: "my-topic",
        ntfyServer: "https://ntfy.sh",
        authToken: "",
        notifications: { stopWithContinue: true },
      })),
    });
    await processStop({}, deps);

    const waitCall = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(waitCall.timeout, 120 * 1000);
  });

  it("should thread authToken through sendNotification, waitForResponse, and action", async () => {
    const deps = makeDeps({
      loadConfig: mock.fn(() => ({
        topic: "my-topic",
        ntfyServer: "https://ntfy.sh",
        authToken: "tk_secret",
        timeout: 120,
        continueTimeout: 60,
        notifications: { stopWithContinue: true },
      })),
    });
    await processStop({}, deps);

    // sendNotification should receive authToken
    const sendArgs = deps.sendNotification.mock.calls[0].arguments[0];
    assert.equal(sendArgs.authToken, "tk_secret");

    // waitForResponse should receive authToken
    const waitArgs = deps.waitForResponse.mock.calls[0].arguments[0];
    assert.equal(waitArgs.authToken, "tk_secret");

    // The Continue action should have Authorization header
    const action = sendArgs.actions[0];
    assert.ok(action.headers, "action should have headers");
    assert.equal(action.headers.Authorization, "Bearer tk_secret");
  });

  it("should return null when response has neither continue, timeout, nor error", async () => {
    const deps = makeDeps({
      waitForResponse: mock.fn(async () => ({ approved: true })),
    });
    const result = await processStop({}, deps);
    assert.equal(result, null);
  });
});
