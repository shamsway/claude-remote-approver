#!/usr/bin/env node

/**
 * CLI entry point for claude-remote-approver.
 *
 * Subcommands: setup | test | status | enable | disable | uninstall | hook
 * All I/O goes through the injected `deps` object so the module is fully testable.
 */

import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import qrcode from "qrcode-terminal";
import { ASK } from "../src/hook.mjs";

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(args, deps) {
  if (args.includes("--help") || args.includes("-h")) {
    deps.stdout.write("Usage: claude-remote-approver <command>\n\nCommands:\n  setup       Set up remote approval\n  test        Send a test notification\n  status      Show current configuration\n  enable      Re-enable the hook\n  disable     Temporarily disable the hook\n  uninstall   Remove hook and delete configuration\n  stop        Stop the background SSE listener\n  hook        Process a Claude Code hook (internal)\n  notify      Send a fire-and-forget notification (internal)\n  context     Output SessionStart context JSON (internal)\n  prompt      Display the system prompt text\n");
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    deps.stdout.write(`${deps.version}\n`);
    return;
  }

  const command = args[0];

  switch (command) {
    case "setup": {
      const allowInsecure = args.includes("--allow-insecure");
      const originalLoadConfig = deps.loadConfig;
      const wrappedLoadConfig = allowInsecure
        ? (...a) => { const c = originalLoadConfig(...a); c.allowInsecure = true; return c; }
        : originalLoadConfig;
      const result = await deps.runSetup({
        ...deps,
        loadConfig: wrappedLoadConfig,
        validateToken: deps.validateToken,
        stderr: deps.stderr,
      });
      deps.stdout.write(`Setup complete. Topic: ${result.topic}\n\n`);

      try {
        const serverUrl = new URL(result.ntfyServer);
        const isHttps = serverUrl.protocol === "https:";
        const ntfyUrl = isHttps
          ? `ntfy://${serverUrl.host}/${result.topic}`
          : `${result.ntfyServer.replace(/\/+$/, "")}/${result.topic}`;
        const subscribeUrl = `${result.ntfyServer.replace(/\/+$/, "")}/${result.topic}`;

        deps.stdout.write("Scan this QR code in the ntfy app to subscribe:\n\n");
        // qrcode-terminal invokes the callback synchronously
        deps.generateQR(ntfyUrl, { small: true }, (qrString) => {
          deps.stdout.write(qrString + "\n\n");
          deps.stdout.write(`Subscribe URL: ${subscribeUrl}\n`);
        });
      } catch {
        deps.stderr.write(`Warning: Invalid ntfyServer URL in config: ${result.ntfyServer}\n`);
        deps.stdout.write(`Subscribe to topic "${result.topic}" in the ntfy app.\n`);
      }
      break;
    }

    case "test": {
      const config = deps.loadConfig();
      if (!config.topic) {
        deps.stderr.write("Error: No topic configured. Run 'claude-remote-approver setup' first.\n");
        break;
      }
      try {
        await deps.sendNotification({
          server: config.ntfyServer,
          topic: config.topic,
          title: "Claude Remote Approver",
          message: "Test notification - if you see this, setup is working!",
          actions: [],
          requestId: "test",
          authToken: config.authToken,
        });
        deps.stdout.write("Test notification sent successfully.\n");
      } catch (err) {
        deps.stderr.write(`Error: Failed to send notification: ${err.message}\n`);
      }
      break;
    }

    case "status": {
      const config = deps.loadConfig();
      deps.stdout.write(`Topic:   ${config.topic}\n`);
      deps.stdout.write(`Server:  ${config.ntfyServer}\n`);
      deps.stdout.write(`Auth:    ${config.authToken ? `${config.authToken.slice(0, 7)}... (configured)` : "none"}\n`);
      deps.stdout.write(`Timeout: ${config.timeout}s / ${config.planTimeout ?? 300}s (plan)`);
      if (config.continueTimeout && config.continueTimeout !== config.timeout) {
        deps.stdout.write(` / ${config.continueTimeout}s (continue)`);
      }
      deps.stdout.write("\n");
      if (config.notifications) {
        deps.stdout.write("Notifications:\n");
        const labels = {
          idle: "Idle prompt",
          stop: config.notifications.stopWithContinue ? "Stop + Continue" : "Stop (finished)",
          sessionStart: "Session start",
          sessionEnd: "Session end",
          toolFailure: "Tool failure",
          subagentStop: "Subagent stop",
        };
        for (const [key, label] of Object.entries(labels)) {
          const enabled = config.notifications[key];
          deps.stdout.write(`  ${enabled ? "\u2713" : "\u2717"} ${label}\n`);
        }
      }
      break;
    }

    case "hook": {
      let input;
      try {
        input = JSON.parse(deps.stdin);
      } catch {
        deps.stderr.write("[claude-remote-approver] Invalid hook input. Falling back to CLI.\n");
        deps.stdout.write(JSON.stringify(ASK) + "\n");
        break;
      }

      let result;
      try {
        result = await deps.processHook(input, deps);
      } catch {
        deps.stderr.write("[claude-remote-approver] Hook processing failed. Falling back to CLI.\n");
        deps.stdout.write(JSON.stringify(ASK) + "\n");
        break;
      }

      deps.stdout.write(JSON.stringify(result) + "\n");
      break;
    }

    case "uninstall": {
      try {
        deps.unregisterAllHooks(deps.settingsPath);
      } catch (err) {
        deps.stderr.write(`Error: Failed to remove hook: ${err.message}\n`);
        break;
      }
      try {
        deps.unlinkSync(deps.configPath);
      } catch (err) {
        if (err.code !== "ENOENT") {
          deps.stderr.write(`Error: Failed to delete config: ${err.message}\n`);
          break;
        }
      }
      deps.stdout.write("Uninstalled. Hook removed and configuration deleted.\n");
      break;
    }

    case "disable": {
      try {
        deps.unregisterAllHooks(deps.settingsPath);
      } catch (err) {
        deps.stderr.write(`Error: Failed to disable hook: ${err.message}\n`);
        break;
      }
      deps.stdout.write("Hook disabled. Run 'claude-remote-approver enable' to re-enable.\n");
      break;
    }

    case "enable": {
      const config = deps.loadConfig();
      if (!config.topic) {
        deps.stderr.write("Error: No topic configured. Run 'claude-remote-approver setup' first.\n");
        deps.exit(1);
        break;
      }
      try {
        deps.registerHook(deps.settingsPath, deps.getHookCommand());
      } catch (err) {
        deps.stderr.write(`Error: Failed to enable hook: ${err.message}\n`);
        break;
      }
      deps.stdout.write("Hook enabled.\n");
      break;
    }

    case "notify": {
      let input;
      try {
        input = JSON.parse(deps.stdin);
      } catch {
        deps.stderr.write("[claude-remote-approver] Invalid notify input.\n");
        break;
      }
      try {
        await deps.processNotify(input, deps);
      } catch (err) {
        deps.stderr.write(`[claude-remote-approver] Notify failed: ${err.message}\n`);
      }
      break;
    }

    case "stop": {
      let input;
      try {
        input = JSON.parse(deps.stdin);
      } catch {
        deps.stderr.write("[claude-remote-approver] Invalid stop input.\n");
        break;
      }
      try {
        const result = await deps.processStop(input, deps);
        if (result !== null) {
          deps.stdout.write(JSON.stringify(result) + "\n");
        }
      } catch (err) {
        deps.stderr.write(`[claude-remote-approver] Stop processing failed: ${err.message}\n`);
      }
      break;
    }

    case "context": {
      const config = deps.loadConfig();
      const result = deps.generateContext(config);
      deps.stdout.write(JSON.stringify(result) + "\n");
      break;
    }

    case "prompt": {
      const config = deps.loadConfig();
      const result = deps.generateContext(config);
      deps.stdout.write(result.hookSpecificOutput.additionalContext + "\n");
      break;
    }

    default: {
      deps.stderr.write(
        "Usage: claude-remote-approver <command>\n\nCommands:\n  setup       Set up remote approval\n  test        Send a test notification\n  status      Show current configuration\n  enable      Re-enable the hook\n  disable     Temporarily disable the hook\n  uninstall   Remove hook and delete configuration\n  stop        Stop the background SSE listener\n  hook        Process a Claude Code hook (internal)\n  notify      Send a fire-and-forget notification (internal)\n  context     Output SessionStart context JSON (internal)\n  prompt      Display the system prompt text\n",
      );
      deps.exit(1);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-execute when run directly (not imported)
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (() => {
    try {
      return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
    } catch {
      return false;
    }
  })();

if (isMain) {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

  const { loadConfig, saveConfig, generateTopic } = await import(
    "../src/config.mjs"
  );
  const { sendNotification, waitForResponse, formatToolInfo, validateToken } = await import(
    "../src/ntfy.mjs"
  );
  const { processHook } = await import("../src/hook.mjs");
  const { processNotify } = await import("../src/notify.mjs");
  const { processStop } = await import("../src/stop.mjs");
  const { generateContext } = await import("../src/context.mjs");
  const { runSetup, registerHook, getHookCommand, unregisterHook, unregisterAllHooks } = await import("../src/setup.mjs");

  const args = process.argv.slice(2);

  // Only read stdin for commands that need it (hook, notify).
  // Other commands (context, prompt, status, etc.) don't use stdin,
  // and blocking on it causes hangs when run as a hook with no input piped.
  const needsStdin = ["hook", "notify", "stop"].includes(args[0]);
  let stdinData = "";
  if (needsStdin && !process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    stdinData = Buffer.concat(chunks).toString("utf-8");
  }

  const deps = {
    loadConfig,
    saveConfig,
    generateTopic,
    sendNotification,
    waitForResponse,
    formatToolInfo,
    validateToken,
    processHook,
    processNotify,
    processStop,
    generateContext,
    runSetup,
    registerHook,
    getHookCommand,
    unregisterHook,
    unregisterAllHooks,
    version: pkg.version,
    generateQR: (text, opts, cb) => qrcode.generate(text, opts, cb),
    unlinkSync: fs.unlinkSync,
    configPath: (await import("../src/config.mjs")).CONFIG_PATH,
    settingsPath: path.join(os.homedir(), ".claude", "settings.json"),
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: stdinData,
    exit: process.exit,
  };

  await main(args, deps);
}
