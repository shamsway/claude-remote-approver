import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const CONFIG_PATH = path.join(os.homedir(), ".claude-remote-approver.json");

export const DEFAULT_CONFIG = {
  topic: "",
  ntfyServer: "https://ntfy.sh",
  authToken: "",
  timeout: 120,
  planTimeout: 300,
  continueTimeout: 120,
  allowInsecure: false,
  // autoApprove/autoDeny are reserved for future use and not yet implemented
  autoApprove: [],
  autoDeny: [],
  notifications: {
    idle: false,
    stop: true,
    sessionStart: false,
    sessionEnd: false,
    toolFailure: false,
    subagentStop: false,
    stopWithContinue: false,
  },
};

function applyEnvOverrides(config) {
  if (process.env.CCR_NTFY_TOPIC) config.topic = process.env.CCR_NTFY_TOPIC;
  if (process.env.CCR_NTFY_SERVER) config.ntfyServer = process.env.CCR_NTFY_SERVER;
  if (process.env.CCR_NTFY_TOKEN) config.authToken = process.env.CCR_NTFY_TOKEN;
  if (process.env.CCR_CONTINUE_TIMEOUT) {
    const val = Number(process.env.CCR_CONTINUE_TIMEOUT);
    if (Number.isFinite(val) && val > 0) config.continueTimeout = val;
  }
  return config;
}

export function loadConfig(configPath = CONFIG_PATH) {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const fileConfig = JSON.parse(raw);
    const config = { ...DEFAULT_CONFIG, ...fileConfig };
    if (typeof config.topic !== "string") config.topic = DEFAULT_CONFIG.topic;
    if (typeof config.ntfyServer !== "string") config.ntfyServer = DEFAULT_CONFIG.ntfyServer;
    if (!Number.isFinite(config.timeout) || config.timeout <= 0) config.timeout = DEFAULT_CONFIG.timeout;
    if (!Number.isFinite(config.planTimeout) || config.planTimeout <= 0) config.planTimeout = DEFAULT_CONFIG.planTimeout;
    if (!Number.isFinite(config.continueTimeout) || config.continueTimeout <= 0) config.continueTimeout = DEFAULT_CONFIG.continueTimeout;
    if (typeof config.allowInsecure !== "boolean") config.allowInsecure = DEFAULT_CONFIG.allowInsecure;
    if (!Array.isArray(config.autoApprove)) config.autoApprove = DEFAULT_CONFIG.autoApprove;
    if (!Array.isArray(config.autoDeny)) config.autoDeny = DEFAULT_CONFIG.autoDeny;
    if (typeof config.authToken !== "string") config.authToken = DEFAULT_CONFIG.authToken;
    if (typeof config.notifications !== "object" || config.notifications === null || Array.isArray(config.notifications)) {
      config.notifications = { ...DEFAULT_CONFIG.notifications };
    } else {
      config.notifications = { ...DEFAULT_CONFIG.notifications, ...config.notifications };
    }
    return applyEnvOverrides(config);
  } catch (err) {
    if (err.code === "ENOENT") {
      return applyEnvOverrides({ ...DEFAULT_CONFIG });
    }
    throw err;
  }
}

export function saveConfig(config, configPath = CONFIG_PATH) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function generateTopic() {
  return `cra-${crypto.randomBytes(16).toString("hex")}`;
}

export function isInsecureServer(server) {
  try {
    const url = new URL(server);
    if (url.protocol !== "http:") return false;
    const hostname = url.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
