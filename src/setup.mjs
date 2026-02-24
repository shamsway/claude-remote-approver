import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInsecureServer } from "./config.mjs";

/**
 * Returns true if the entry belongs to claude-remote-approver.
 */
function isCraEntry(entry) {
  if (entry.hooks?.some((h) => h.command?.includes("claude-remote-approver"))) return true;
  if (entry.command?.includes("claude-remote-approver")) return true;
  return false;
}

const NOTIFICATION_HOOK_EVENTS = {
  idle: "Notification",
  stop: "Stop",
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  toolFailure: "PostToolUseFailure",
  subagentStop: "SubagentStop",
};

/**
 * Returns the hook command string: `node <absolute_path_to_bin/cli.mjs> hook`
 */
export function getHookCommand() {
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");
  if (!fs.existsSync(cliPath)) {
    throw new Error(`CLI entry point not found: ${cliPath}`);
  }
  return `node "${cliPath}" hook`;
}

/**
 * Returns the notify command string: `node <absolute_path_to_bin/cli.mjs> notify`
 */
export function getNotifyCommand() {
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");
  if (!fs.existsSync(cliPath)) {
    throw new Error(`CLI entry point not found: ${cliPath}`);
  }
  return `node "${cliPath}" notify`;
}

/**
 * Returns the context command string: `node <absolute_path_to_bin/cli.mjs> context`
 */
export function getContextCommand() {
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");
  if (!fs.existsSync(cliPath)) {
    throw new Error(`CLI entry point not found: ${cliPath}`);
  }
  return `node "${cliPath}" context`;
}

/**
 * Registers notification hooks and a context hook in Claude's settings.json.
 * Only registers hooks for enabled notification types.
 * Always registers the SessionStart context hook when contextCommand is provided.
 */
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

/**
 * Registers the PermissionRequest hook in Claude's settings.json.
 * Creates the file if it does not exist. Preserves all existing settings and hooks.
 */
export function registerHook(settingsPath, hookCommand) {
  let settings = {};

  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    settings = JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  if (!Array.isArray(settings.hooks.PermissionRequest)) {
    settings.hooks.PermissionRequest = [];
  }

  const existingIndex = settings.hooks.PermissionRequest.findIndex(isCraEntry);

  const hookEntry = { hooks: [{ type: "command", command: hookCommand }] };

  if (existingIndex >= 0) {
    settings.hooks.PermissionRequest[existingIndex] = hookEntry;
  } else {
    settings.hooks.PermissionRequest.push(hookEntry);
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

const ALL_HOOK_EVENTS = ["PermissionRequest", "Notification", "Stop", "SessionStart", "SessionEnd", "PostToolUseFailure", "SubagentStop"];

/**
 * Removes CRA entries from ALL hook event types in Claude's settings.json.
 * If the file does not exist, does nothing.
 */
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

/**
 * Removes the claude-remote-approver hook entry from Claude's settings.json.
 * If the file does not exist, does nothing.
 */
export function unregisterHook(settingsPath) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }

  if (!settings.hooks?.PermissionRequest) return;

  const original = settings.hooks.PermissionRequest;
  const filtered = original.filter((entry) => !isCraEntry(entry));

  if (filtered.length === original.length) return;

  if (filtered.length === 0) {
    delete settings.hooks.PermissionRequest;
  } else {
    settings.hooks.PermissionRequest = filtered;
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * Runs the full setup flow:
 * 1. Generate a topic
 * 2. Build and save config
 * 3. Register the PermissionRequest hook in settings.json
 * 4. Register notification hooks and context hook
 * 5. Return { topic, ntfyServer, configPath, settingsPath }
 */
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

  // Register notification hooks and context hook
  const notifyCommand = getNotifyCommand();
  const contextCommand = getContextCommand();
  registerNotificationHooks(settingsPath, notifyCommand, config.notifications || {}, contextCommand);

  return { topic, ntfyServer: config.ntfyServer, configPath, settingsPath };
}
