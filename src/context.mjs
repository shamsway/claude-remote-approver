// src/context.mjs

export function generateContext(config) {
  let ctx = `## Remote Approval Context

Permission requests and questions in this session are delivered to the user's phone via push notifications (ntfy). Keep these constraints in mind:

### Permission Requests
- The user sees a notification with Approve/Deny buttons on their phone
- Keep tool descriptions concise — messages are truncated at 1000 characters
- Batch related file operations when possible to reduce notification volume
- Response timeout: ${config.timeout}s (${config.planTimeout}s for plan reviews)

### Questions (AskUserQuestion)
- Each notification supports a maximum of 3 action buttons
- Questions with >3 options are split across multiple notifications — prefer ≤3 options when possible
- The user cannot type free-text responses remotely; "Other" requires them to use the CLI
- Keep option labels short (they become button text on a phone screen)
- Prefer 2-3 clear options over many granular ones
- Option descriptions are shown in the notification body — keep them to one line each

### General
- Responses may have higher latency than a local terminal
- Minimize the total number of permission prompts and questions per task
- When a task can proceed with reasonable defaults, prefer that over asking`;

  if (config.notifications?.stopWithContinue) {
    ctx += `
- When you finish a task, the user receives a notification with a Continue button
  They can tap it to request you keep working — wait for this before considering the task complete`;
  }

  return {
    hookSpecificOutput: {
      additionalContext: ctx,
    },
  };
}
