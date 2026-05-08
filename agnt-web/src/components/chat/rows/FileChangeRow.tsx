import { useState } from "react";
import type { CodexMessage } from "../../../models";

export function FileChangeRow({ message }: { message: CodexMessage }) {
  const [expanded, setExpanded] = useState(false);
  const fileChange = message.fileChange;
  if (!fileChange) return null;
  return (
    <div className="agnt-row agnt-row-filechange">
      <button
        type="button"
        className="agnt-row-filechange-summary"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
      >
        <span className="agnt-row-tag">File change</span>
        <code>{fileChange.path ?? "(unknown path)"}</code>
      </button>
      {expanded && fileChange.diff && <pre className="agnt-row-filechange-diff">{fileChange.diff}</pre>}
    </div>
  );
}
