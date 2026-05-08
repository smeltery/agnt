import { useState } from "react";
import { copyText } from "../../../lib/clipboard";
import type { CodexMessage } from "../../../models";
import { MarkdownContent } from "../MarkdownContent";

export function AssistantRow({ message }: { message: CodexMessage }) {
  const [justCopied, setJustCopied] = useState(false);

  async function handleCopy() {
    const ok = await copyText(message.text);
    if (!ok) return;
    setJustCopied(true);
    window.setTimeout(() => setJustCopied(false), 1200);
  }

  return (
    <div className={"agnt-row agnt-row-assistant" + (message.isStreaming ? " agnt-row-streaming" : "")}>
      <div className="agnt-row-bubble">
        <MarkdownContent text={message.text} />
        {message.isStreaming && <span className="agnt-cursor-blink" aria-hidden />}
      </div>
      {!message.isStreaming && message.text && (
        <button
          type="button"
          className={"agnt-row-copy" + (justCopied ? " agnt-row-copy-done" : "")}
          onClick={handleCopy}
          aria-label={justCopied ? "Copied" : "Copy message"}
        >
          {justCopied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}
