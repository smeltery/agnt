import { useState } from "react";
import { copyText } from "../../../lib/clipboard";
import type { CodexMessage } from "../../../models";
import { useCheckpointsStore } from "../../../state/checkpoints-store";
import { useConnectionStore } from "../../../state/connection-store";
import { useThreadsStore } from "../../../state/threads-store";
import { MarkdownContent } from "../MarkdownContent";

export function AssistantRow({ message }: { message: CodexMessage }) {
  const [justCopied, setJustCopied] = useState(false);
  const showCheckpoints = useCheckpointsStore((state) => state.show);
  const connection = useConnectionStore((state) => state.connection);
  const thread = useThreadsStore((state) => {
    if (message.threadId)
      return state.threads.find((t) => t.id === message.threadId)
        ?? state.archivedThreads.find((t) => t.id === message.threadId);
    return undefined;
  });

  async function handleCopy() {
    const ok = await copyText(message.text);
    if (!ok) return;
    setJustCopied(true);
    window.setTimeout(() => setJustCopied(false), 1200);
  }

  function handleRevert() {
    if (!connection?.rpc || !message.turnId || !thread?.cwd) return;
    void showCheckpoints(connection.rpc, {
      threadId: message.threadId,
      turnId: message.turnId,
      cwd: thread.cwd,
    });
  }

  // Revert is only meaningful when the turn is closed AND we know the cwd —
  // without cwd the bridge errors with missing_working_directory anyway, so
  // hiding the button beats showing a broken one.
  const canRevert = !message.isStreaming && Boolean(message.turnId) && Boolean(thread?.cwd);

  return (
    <div
      className={"agnt-row agnt-row-assistant" + (message.isStreaming ? " agnt-row-streaming" : "")}
      title={new Date(message.createdAt).toLocaleString()}
    >
      <div className="agnt-row-bubble">
        <MarkdownContent text={message.text} cwd={thread?.cwd} />
        {message.isStreaming && <span className="agnt-cursor-blink" aria-hidden />}
      </div>
      {!message.isStreaming && message.text && (
        <div className="agnt-row-actions">
          {canRevert && (
            <button
              type="button"
              className="agnt-row-action"
              onClick={handleRevert}
              title="Roll the workspace back to before this turn"
            >
              ↶ Revert
            </button>
          )}
          <button
            type="button"
            className={"agnt-row-action" + (justCopied ? " agnt-row-action-done" : "")}
            onClick={handleCopy}
            aria-label={justCopied ? "Copied" : "Copy message"}
          >
            {justCopied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}
