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
    const result = formatNotification({ hook_event_name: "Stop", stop_hook_active: true });
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
          topic: "my-topic", ntfyServer: "https://ntfy.sh", authToken: "",
          notifications: { stop: true },
        }),
        sendNotification: async (params) => { sendCalls.push(params); return { ok: true }; },
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
          topic: "my-topic", ntfyServer: "https://ntfy.sh", authToken: "",
          notifications: { stop: false },
        }),
        sendNotification: async (params) => { sendCalls.push(params); return { ok: true }; },
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
          topic: "", ntfyServer: "https://ntfy.sh",
          notifications: { stop: true },
        }),
        sendNotification: async (params) => { sendCalls.push(params); return { ok: true }; },
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
          topic: "my-topic", ntfyServer: "https://ntfy.example.com", authToken: "tk_test123",
          notifications: { stop: true },
        }),
        sendNotification: async (params) => { sendCalls.push(params); return { ok: true }; },
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
            topic: "my-topic", ntfyServer: "https://ntfy.sh", authToken: "",
            notifications: { stop: true },
          }),
          sendNotification: async () => { throw new Error("network error"); },
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
          topic: "my-topic", ntfyServer: "https://ntfy.sh", authToken: "",
          notifications: { idle: true },
        }),
        sendNotification: async (params) => { sendCalls.push(params); return { ok: true }; },
      },
    );
    assert.equal(sendCalls.length, 1);
  });
});
