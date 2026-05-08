import { useState } from "react";
import type { CodexMessage } from "../../../models";

export function CommandExecutionRow({ message }: { message: CodexMessage }) {
  const [expanded, setExpanded] = useState(false);
  const command = message.command;
  if (!command) return null;
  const status = message.isStreaming ? "running" : command.exitCode === 0 ? "completed" : command.exitCode !== undefined ? "failed" : "completed";
  const summary = command.fullCommand || message.text || "shell command";
  return (
    <div className="agnt-row agnt-row-command">
      <button
        type="button"
        className="agnt-row-command-summary"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
      >
        <span className={"agnt-row-tag agnt-row-command-status-" + status}>{status}</span>
        <code>{summary}</code>
      </button>
      {expanded && command.outputTail && <pre className="agnt-row-command-output">{command.outputTail}</pre>}
      {command.exitCode !== undefined && !message.isStreaming && (
        <div className="agnt-row-command-meta">
          exit {command.exitCode}
          {command.durationMs !== undefined ? ` · ${(command.durationMs / 1000).toFixed(2)}s` : ""}
        </div>
      )}
    </div>
  );
}
