// src/stop.mjs

import crypto from "node:crypto";
import { sendWithRetry } from "./hook.mjs";

/**
 * Build a single "Continue" action button for ntfy.
 *
 * @param {string} server - ntfy server URL
 * @param {string} topic - ntfy topic
 * @param {string} requestId - Unique request identifier
 * @param {object} [options] - Optional settings
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
 * Process a Stop hook event by sending a "Claude has finished" notification
 * with a Continue button. Blocks if the user taps Continue.
 *
 * @param {object} input - The hook input payload (unused but kept for API consistency)
 * @param {object} deps - Injected dependencies
 * @param {Function} deps.loadConfig
 * @param {Function} deps.sendNotification
 * @param {Function} deps.waitForResponse
 * @returns {Promise<{decision: string, reason: string} | null>}
 */
export async function processStop(input, deps) {
  const config = deps.loadConfig();

  if (!config.topic || !config.notifications?.stopWithContinue) {
    return null;
  }

  const requestId = crypto.randomUUID();
  const { ntfyServer: server, topic, authToken } = config;

  const action = buildContinueAction(server, topic, requestId, { authToken });

  const sent = await sendWithRetry(deps.sendNotification, {
    server,
    topic,
    title: "Claude Code",
    message: "Claude has finished responding",
    priority: 3,
    tags: ["white_check_mark"],
    actions: [action],
    requestId,
    authToken,
  });

  if (!sent) {
    return null;
  }

  const timeout = ((config.continueTimeout ?? config.timeout) || 120) * 1000;

  const response = await deps.waitForResponse({
    server,
    topic,
    requestId,
    timeout,
    authToken,
  });

  if (response.timeout || response.error) {
    return null;
  }

  if (response.continue === true) {
    return { decision: "block", reason: "User requested continuation" };
  }

  return null;
}
