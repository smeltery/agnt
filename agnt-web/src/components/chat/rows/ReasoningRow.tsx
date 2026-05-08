import { useState } from "react";
import type { CodexMessage } from "../../../models";

// Reasoning rows can get long; collapse by default and let the user expand.
// Streaming rows stay open so the user can watch the model think.
export function ReasoningRow({ message }: { message: CodexMessage }) {
  const [expanded, setExpanded] = useState(message.isStreaming);
  const showText = expanded || message.isStreaming;
  return (
    <div className="agnt-row agnt-row-reasoning">
      <button
        className="agnt-row-tag agnt-row-reasoning-toggle"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={showText}
      >
        Thinking{message.isStreaming ? "…" : ""}
      </button>
      {showText && <div className="agnt-row-reasoning-text">{message.text}</div>}
    </div>
  );
}
