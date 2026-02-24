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
  // autoApprove/autoDeny are reserved for future use and not yet implemented
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

export function loadConfig(configPath = CONFIG_PATH) {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const fileConfig = JSON.parse(raw);
    const config = { ...DEFAULT_CONFIG, ...fileConfig };
    if (typeof config.topic !== "string") config.topic = DEFAULT_CONFIG.topic;
    if (typeof config.ntfyServer !== "string") config.ntfyServer = DEFAULT_CONFIG.ntfyServer;
    if (!Number.isFinite(config.timeout) || config.timeout <= 0) config.timeout = DEFAULT_CONFIG.timeout;
    if (!Number.isFinite(config.planTimeout) || config.planTimeout <= 0) config.planTimeout = DEFAULT_CONFIG.planTimeout;
    if (!Array.isArray(config.autoApprove)) config.autoApprove = DEFAULT_CONFIG.autoApprove;
    if (!Array.isArray(config.autoDeny)) config.autoDeny = DEFAULT_CONFIG.autoDeny;
    if (typeof config.authToken !== "string") config.authToken = DEFAULT_CONFIG.authToken;
    if (typeof config.notifications !== "object" || config.notifications === null || Array.isArray(config.notifications)) {
      config.notifications = { ...DEFAULT_CONFIG.notifications };
    } else {
      config.notifications = { ...DEFAULT_CONFIG.notifications, ...config.notifications };
    }
    return config;
  } catch (err) {
    if (err.code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
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
