import { useState } from "react";
import { copyText } from "../../../lib/clipboard";
import { quoteAsMarkdown } from "../../../lib/quote";
import type { CodexMessage } from "../../../models";
import { useCheckpointsStore } from "../../../state/checkpoints-store";
import { useComposerInboxStore } from "../../../state/composer-inbox-store";
import { useConnectionStore } from "../../../state/connection-store";
import { useThreadsStore } from "../../../state/threads-store";
import { formatTurnDuration, useTurnTimingStore } from "../../../state/turn-timing-store";
import { ArrowshapeTurnUpLeft, ArrowUturnLeft, Clock } from "../../shared/Icon";
import { BookmarkButton } from "./BookmarkButton";
import { RowLinkButton } from "./RowLinkButton";
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
  const timing = useTurnTimingStore((state) => (message.turnId ? state.byTurn[message.turnId] : undefined));
  const durationLabel = timing ? formatTurnDuration(timing) : null;

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

  function handleReply() {
    if (!message.threadId) return;
    const quoted = quoteAsMarkdown(message.text);
    if (!quoted) return;
    useComposerInboxStore.getState().request({
      threadId: message.threadId,
      body: `${quoted}\n\n`,
    });
    document.getElementById("agnt-composer-input")?.focus();
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
          {durationLabel && (
            <span
              className="agnt-row-action-meta"
              title="Time from turn start to turn end (this session)"
            >
              <Clock /> {durationLabel}
            </span>
          )}
          <BookmarkButton threadId={message.threadId} messageId={message.id} />
          <RowLinkButton threadId={message.threadId} messageId={message.id} />
          <button
            type="button"
            className="agnt-row-action"
            onClick={handleReply}
            title="Quote this message into a new draft"
          >
            <ArrowshapeTurnUpLeft /> Reply
          </button>
          {canRevert && (
            <button
              type="button"
              className="agnt-row-action"
              onClick={handleRevert}
              title="Roll the workspace back to before this turn"
            >
              <ArrowUturnLeft /> Revert
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
