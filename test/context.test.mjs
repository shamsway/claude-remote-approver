import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateContext } from "../src/context.mjs";

describe("generateContext", () => {
  it("should return object with hookSpecificOutput.additionalContext", () => {
    const result = generateContext({ timeout: 120, planTimeout: 300, notifications: {} });
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
