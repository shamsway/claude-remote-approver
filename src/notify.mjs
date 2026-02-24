const MESSAGE_MAX_LENGTH = 1000;

const EVENT_CONFIG_MAP = {
  Notification: "idle",
  Stop: "stop",
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  PostToolUseFailure: "toolFailure",
  SubagentStop: "subagentStop",
};

export function formatNotification(input) {
  switch (input.hook_event_name) {
    case "Notification":
      return {
        title: input.notification?.title || "Claude Code",
        message: input.notification?.body || "Waiting for input",
        priority: 4,
        tags: ["hourglass_flowing_sand"],
      };
    case "Stop":
      return {
        title: "Claude Code",
        message: "Claude has finished responding",
        priority: 3,
        tags: ["white_check_mark"],
      };
    case "PostToolUseFailure": {
      let msg = input.error || "Unknown error";
      if (msg.length > MESSAGE_MAX_LENGTH) {
        msg = msg.slice(0, MESSAGE_MAX_LENGTH) + "...";
      }
      return {
        title: `Tool Failed: ${input.tool_name || "Unknown"}`,
        message: msg,
        priority: 4,
        tags: ["warning", "x"],
      };
    }
    case "SessionStart":
      return {
        title: "Claude Code",
        message: "Session started",
        priority: 2,
        tags: ["rocket"],
      };
    case "SessionEnd":
      return {
        title: "Claude Code",
        message: "Session ended",
        priority: 2,
        tags: ["stop_sign"],
      };
    case "SubagentStop":
      return {
        title: "Claude Code",
        message: "Subagent finished",
        priority: 2,
        tags: ["robot_face"],
      };
    default:
      return null;
  }
}

export async function processNotify(input, deps) {
  const config = deps.loadConfig();
  if (!config.topic) return;

  const configKey = EVENT_CONFIG_MAP[input.hook_event_name];
  if (!configKey || !config.notifications?.[configKey]) return;

  const notification = formatNotification(input);
  if (!notification) return;

  try {
    await deps.sendNotification({
      server: config.ntfyServer,
      topic: config.topic,
      title: notification.title,
      message: notification.message,
      actions: [],
      requestId: "notify",
      authToken: config.authToken,
      priority: notification.priority,
      tags: notification.tags,
    });
  } catch (err) {
    console.error("[claude-remote-approver] Notification send failed:", err.message);
  }
}
