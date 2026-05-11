import { useState } from "react";
import { copyText } from "../../../lib/clipboard";
import { computeDiffStats, sumDiffStats } from "../../../lib/git-diff-stats";
import { formatRelativeWithAbsolute } from "../../../lib/relative-time";
import { isSpeaking, isTtsSupported, speak, stop as stopSpeaking } from "../../../lib/tts";
import { quoteAsMarkdown } from "../../../lib/quote";
import { formatCostUsd, formatTokens, totalTokens } from "../../../lib/token-usage";
import type { CodexMessage } from "../../../models";
import { useCheckpointsStore } from "../../../state/checkpoints-store";
import { useComposerInboxStore } from "../../../state/composer-inbox-store";
import { useConnectionStore } from "../../../state/connection-store";
import { useThreadsStore } from "../../../state/threads-store";
import { formatTurnDuration, useTurnTimingStore } from "../../../state/turn-timing-store";
import { useTurnTokenUsageStore } from "../../../state/turn-token-usage-store";
import { ArrowshapeTurnUpLeft, ArrowUturnLeft, Clock } from "../../shared/Icon";
import { BookmarkButton } from "./BookmarkButton";
import { RowLinkButton } from "./RowLinkButton";
import { MarkdownContent } from "../MarkdownContent";

export function AssistantRow({ message }: { message: CodexMessage }) {
  const [justCopied, setJustCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);
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
  const tokenUsage = useTurnTokenUsageStore((state) => (message.turnId ? state.byTurn[message.turnId] : undefined));

  // AI Change Sets: aggregate the fileChange rows that share this turnId
  // so the user sees at-a-glance how much surface this turn touched.
  // Clicking the chip scrolls to the first matching FileChange row so they
  // can review individual diffs (and, since the bridge ships
  // `workspace/revertPatchApply`, revert each one independently — see
  // FileChangeRow).
  //
  // The selector aggregates by turnId before returning so a re-render only
  // fires when this turn's chip would actually change. Subscribing to the
  // raw messages array would re-run this on every reducer mutation
  // anywhere in the thread.
  const turnChanges = useThreadsStore((state) => {
    if (!message.turnId || !message.threadId) return null;
    const messages = state.reducerStates[message.threadId]?.messages;
    if (!messages) return null;
    let count = 0;
    let firstId: string | null = null;
    let insertions = 0;
    let deletions = 0;
    for (const m of messages) {
      if (m.turnId !== message.turnId || m.kind !== "fileChange" || !m.fileChange?.diff) continue;
      if (firstId === null) firstId = m.id;
      count += 1;
      const stats = computeDiffStats(m.fileChange.diff);
      insertions += stats.insertions;
      deletions += stats.deletions;
    }
    if (count === 0) return null;
    return { count, firstId, totals: sumDiffStats([{ insertions, deletions }]) };
  }, shallowTurnChangesEqual);

  function scrollToFirstChange() {
    if (!turnChanges?.firstId) return;
    const node = document.querySelector(`[data-message-id="${cssEscape(turnChanges.firstId)}"]`);
    if (node instanceof HTMLElement) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function handleSpeak() {
    if (speaking) {
      stopSpeaking();
      setSpeaking(false);
      return;
    }
    speak(message.text);
    setSpeaking(true);
    // Poll once a second to flip the icon back when the platform
    // finishes speaking. SpeechSynthesis doesn't expose a "completed"
    // event in a way that survives all browsers; polling avoids a
    // listener-leak from cancel races.
    const poll = window.setInterval(() => {
      if (!isSpeaking()) {
        setSpeaking(false);
        window.clearInterval(poll);
      }
    }, 1000);
  }

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
      title={formatRelativeWithAbsolute(message.createdAt)}
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
          {tokenUsage && (
            <span
              className="agnt-row-action-meta"
              title={`Input ${tokenUsage.inputTokens.toLocaleString()} · Output ${tokenUsage.outputTokens.toLocaleString()}${tokenUsage.cachedInputTokens ? ` · Cached ${tokenUsage.cachedInputTokens.toLocaleString()}` : ""}${tokenUsage.totalCostUsd != null ? ` · Cost ${formatCostUsd(tokenUsage.totalCostUsd)}` : ""}`}
            >
              {formatTokens(totalTokens(tokenUsage))} tokens
              {tokenUsage.totalCostUsd != null && tokenUsage.totalCostUsd > 0 ? ` · ${formatCostUsd(tokenUsage.totalCostUsd)}` : ""}
            </span>
          )}
          {turnChanges && (
            <button
              type="button"
              className="agnt-row-action agnt-row-action-changes"
              onClick={scrollToFirstChange}
              title={`This turn touched ${turnChanges.count} file${turnChanges.count === 1 ? "" : "s"} (+${turnChanges.totals.insertions} −${turnChanges.totals.deletions}). Click to scroll to the changes.`}
            >
              {turnChanges.count} file{turnChanges.count === 1 ? "" : "s"}{" "}
              <span className="agnt-gitpanel-stat-add">+{turnChanges.totals.insertions}</span>
              {" "}
              <span className="agnt-gitpanel-stat-del">−{turnChanges.totals.deletions}</span>
            </button>
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
          {isTtsSupported() && (
            <button
              type="button"
              className={"agnt-row-action" + (speaking ? " agnt-row-action-active" : "")}
              onClick={handleSpeak}
              aria-label={speaking ? "Stop speaking" : "Read aloud"}
              aria-pressed={speaking}
              title={speaking ? "Stop reading" : "Read this message aloud (Web Speech API)"}
            >
              {speaking ? "Stop" : "Speak"}
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

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/(["\\])/g, "\\$1");
}

// Custom equality for the turnChanges selector. Default zustand shallow
// would walk every key including the nested `totals` and reject equal
// objects with different references. This compares the only fields we
// render so a re-render only happens when the chip would change visually.
function shallowTurnChangesEqual(
  a: { count: number; firstId: string | null; totals: { insertions: number; deletions: number } } | null,
  b: { count: number; firstId: string | null; totals: { insertions: number; deletions: number } } | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.count === b.count &&
    a.firstId === b.firstId &&
    a.totals.insertions === b.totals.insertions &&
    a.totals.deletions === b.totals.deletions
  );
}
