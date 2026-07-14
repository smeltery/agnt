const os = require("os");

const {
  generateItemId,
  readString,
} = require("../_shared/translator-utils");

function createClaudeToolEmitter({
  emitNotification,
  getActiveTurnId,
  getSessionCwd,
  getThreadId,
  pendingToolCalls,
}) {
  function emitToolUseStart(part) {
    const toolUseId = readString(part.id) || generateItemId("tool");
    const toolName = readString(part.name);
    const input = part.input && typeof part.input === "object" ? part.input : {};
    const threadId = getThreadId();
    const activeTurnId = getActiveTurnId();
    if (!threadId || !activeTurnId) return;
    if (pendingToolCalls.has(toolUseId)) return;

    if (toolName === "Bash") {
      const command = readString(input.command);
      const cwd = readString(input.cwd) || getSessionCwd() || "";
      pendingToolCalls.set(toolUseId, { kind: "bash", toolName, command, cwd });
      emitNotification("codex/event/exec_command_begin", {
        threadId, turnId: activeTurnId,
        call_id: toolUseId, command, cwd, status: "running",
      });
      return;
    }

    if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
      const filePath = readString(input.file_path) || readString(input.path) || "";
      pendingToolCalls.set(toolUseId, { kind: "file_read", toolName, filePath });
      emitNotification("item/started", {
        threadId, turnId: activeTurnId, itemId: toolUseId,
        item: {
          id: toolUseId, itemId: toolUseId,
          type: toolName === "Read" ? "file_read" : "tool_call",
          tool: toolName, name: toolName,
          file_path: filePath, path: filePath,
          query: readString(input.pattern) || readString(input.query) || "",
        },
      });
      return;
    }

    if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
      const filePath = readString(input.file_path) || readString(input.path) || "";
      pendingToolCalls.set(toolUseId, { kind: "file_change", toolName, filePath });
      emitNotification("item/started", {
        threadId, turnId: activeTurnId, itemId: toolUseId,
        item: {
          id: toolUseId, itemId: toolUseId,
          type: "file_change",
          tool: toolName, name: toolName,
          file_path: filePath, path: filePath,
        },
      });
      return;
    }

    pendingToolCalls.set(toolUseId, {
      kind: "background", toolName, command: toolName, cwd: getSessionCwd() || "",
    });
    emitNotification("codex/event/background_event", {
      threadId, turnId: activeTurnId,
      call_id: toolUseId, message: describeToolForUi(toolName, input),
    });
  }

  function emitToolResult(part) {
    const toolUseId = readString(part.tool_use_id);
    if (!toolUseId) return;
    const call = pendingToolCalls.get(toolUseId);
    if (!call) return;

    const threadId = getThreadId();
    const activeTurnId = getActiveTurnId();
    const output = readToolResultText(part.content);
    const errored = part.is_error === true;

    if (call.kind === "bash") {
      emitBashResult({ activeTurnId, call, errored, output, threadId, toolUseId });
    } else if (call.kind === "file_read") {
      emitFileReadResult({ activeTurnId, call, errored, output, threadId, toolUseId });
    } else if (call.kind === "file_change") {
      emitFileChangeResult({ activeTurnId, call, errored, output, threadId, toolUseId });
    }

    pendingToolCalls.delete(toolUseId);
  }

  function emitBashResult({ activeTurnId, call, errored, output, threadId, toolUseId }) {
    if (output) {
      emitNotification("codex/event/exec_command_output_delta", {
        threadId, turnId: activeTurnId,
        call_id: toolUseId, command: call.command, cwd: call.cwd,
        chunk: output,
      });
    }
    emitNotification("codex/event/exec_command_end", {
      threadId, turnId: activeTurnId,
      call_id: toolUseId, command: call.command, cwd: call.cwd,
      status: errored ? "error" : "completed",
      output: output || "",
    });
  }

  function emitFileReadResult({ activeTurnId, call, errored, output, threadId, toolUseId }) {
    if (output) {
      emitNotification("item/toolCall/outputDelta", {
        threadId, turnId: activeTurnId, itemId: toolUseId,
        delta: output,
      });
    }
    emitNotification("item/completed", {
      threadId, turnId: activeTurnId, itemId: toolUseId,
      item: {
        id: toolUseId, itemId: toolUseId,
        type: call.toolName === "Read" ? "file_read" : "tool_call",
        tool: call.toolName, name: call.toolName,
        file_path: call.filePath, path: call.filePath,
        status: errored ? "error" : "completed",
        output: output || "",
      },
    });
  }

  function emitFileChangeResult({ activeTurnId, call, errored, output, threadId, toolUseId }) {
    if (output) {
      emitNotification("item/fileChange/outputDelta", {
        threadId, turnId: activeTurnId, itemId: toolUseId,
        delta: output,
      });
    }
    emitNotification("item/completed", {
      threadId, turnId: activeTurnId, itemId: toolUseId,
      item: {
        id: toolUseId, itemId: toolUseId,
        type: "file_change",
        tool: call.toolName, name: call.toolName,
        file_path: call.filePath, path: call.filePath,
        status: errored ? "error" : "completed",
      },
    });
  }

  return {
    emitToolResult,
    emitToolUseStart,
  };
}

function readToolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "text" && typeof entry.text === "string") {
      parts.push(entry.text);
    }
  }
  return parts.join("");
}

function describeToolForUi(toolName, input) {
  switch (toolName) {
    case "Read":      return `Reading ${shortPathOf(input)}`;
    case "Write":     return `Writing ${shortPathOf(input)}`;
    case "Edit":      return `Editing ${shortPathOf(input)}`;
    case "Glob":      return `Searching for ${readString(input.pattern) || "files"}`;
    case "Grep":      return `Grep ${readString(input.pattern) || ""}`;
    case "WebFetch":  return `Fetching ${readString(input.url) || "URL"}`;
    case "WebSearch": return "Searching the web";
    default:          return `Running ${toolName}`;
  }
}

function shortPathOf(input) {
  const filePath = readString(input.file_path) || readString(input.path) || "";
  if (!filePath) return "file";
  const home = os.homedir();
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

module.exports = {
  createClaudeToolEmitter,
};
