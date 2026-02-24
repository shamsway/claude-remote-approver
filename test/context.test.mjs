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

describe("generateContext with stopWithContinue", () => {
  it("should mention Continue button when stopWithContinue is enabled", () => {
    const config = { timeout: 120, planTimeout: 300, notifications: { stopWithContinue: true } };
    const result = generateContext(config);
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(ctx.toLowerCase().includes("continue"));
  });

  it("should not mention Continue button when stopWithContinue is disabled", () => {
    const config = { timeout: 120, planTimeout: 300, notifications: { stopWithContinue: false } };
    const result = generateContext(config);
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(!ctx.toLowerCase().includes("continue button"));
  });

  it("should work when notifications is undefined", () => {
    const config = { timeout: 120, planTimeout: 300 };
    const result = generateContext(config);
    assert.ok(result.hookSpecificOutput.additionalContext.length > 0);
  });
});
