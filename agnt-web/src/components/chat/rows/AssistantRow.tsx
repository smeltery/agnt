import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { collectAssistantChangeSet } from "../../../lib/assistant-change-set";
import { copyText } from "../../../lib/clipboard";
import { formatRelativeWithAbsolute } from "../../../lib/relative-time";
import { isSpeaking, isTtsSupported, speak, stop as stopSpeaking } from "../../../lib/tts";
import { quoteAsMarkdown } from "../../../lib/quote";
import { autoCloseStreamingInlineMarkup } from "../../../lib/streaming-inline-markup";
import { formatCostUsd, formatTokens, totalTokens } from "../../../lib/token-usage";
import type { CodexMessage } from "../../../models";
import { useCheckpointsStore } from "../../../state/checkpoints-store";
import { useComposerInboxStore } from "../../../state/composer-inbox-store";
import { useConnectionStore } from "../../../state/connection-store";
import { useThreadsStore } from "../../../state/threads-store";
import { formatTurnDuration, useTurnTimingStore } from "../../../state/turn-timing-store";
import { useTurnTokenUsageStore } from "../../../state/turn-token-usage-store";
import { revertPatchApply, revertPatchPreview } from "../../../protocol/workspace-checkpoints";
import { ArrowshapeTurnUpLeft, ArrowUturnLeft, Clock, Ellipsis } from "../../shared/Icon";
import { ActionPopover } from "../../shared/ActionPopover";
import { BookmarkButton } from "./BookmarkButton";
import { RowLinkButton } from "./RowLinkButton";
import { MarkdownContent } from "../MarkdownContent";

type ChangeSetRevertState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "applying" }
  | { phase: "blocked"; reason: string }
  | { phase: "done"; files: string[] };

export function AssistantRow({ message }: { message: CodexMessage }) {
  const [justCopied, setJustCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [changeSetRevert, setChangeSetRevert] = useState<ChangeSetRevertState>({ phase: "idle" });
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
  // Flattened so `useShallow` from zustand 5 can do the equality check at
  // the top level. The earlier zustand 4 form used a custom equality
  // function with a nested `totals` object; v5 dropped the 2-arg
  // `useStore(selector, equalityFn)` API, so we use the standard
  // useShallow helper and keep the result shape flat instead.
  const turnChanges = useThreadsStore(useShallow((state) => {
    if (!message.turnId || !message.threadId) return null;
    const messages = state.reducerStates[message.threadId]?.messages;
    if (!messages) return null;
    return collectAssistantChangeSet(messages, message);
  }));

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

  async function handleChangeSetRevert() {
    if (!connection?.rpc || !thread?.cwd || !turnChanges) return;
    setChangeSetRevert({ phase: "checking" });
    try {
      const patches = turnChanges.patches.map((patch) => ({
        id: patch.id,
        forwardPatch: patch.forwardPatch,
      }));
      const preview = await revertPatchPreview(connection.rpc, {
        cwd: thread.cwd,
        patches,
      });
      if (!preview.canRevert) {
        setChangeSetRevert({ phase: "blocked", reason: revertBlockReason(preview) });
        return;
      }
      setChangeSetRevert({ phase: "applying" });
      const result = await revertPatchApply(connection.rpc, {
        cwd: thread.cwd,
        patches,
      });
      if (result.success) {
        setChangeSetRevert({ phase: "done", files: result.revertedFiles });
      } else {
        setChangeSetRevert({ phase: "blocked", reason: revertBlockReason(result) });
      }
    } catch (error) {
      setChangeSetRevert({ phase: "blocked", reason: (error as Error).message });
    }
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
  const renderedText = message.isStreaming ? autoCloseStreamingInlineMarkup(message.text) : message.text;

  return (
    <div
      className={"agnt-row agnt-row-assistant" + (message.isStreaming ? " agnt-row-streaming" : "")}
      title={formatRelativeWithAbsolute(message.createdAt)}
    >
      <div className="agnt-assistant-identity"><img src="/icon-192.png" width="22" height="22" alt="" /><span>Assistant</span></div>
      <div className="agnt-row-bubble">
        <MarkdownContent text={renderedText} cwd={thread?.cwd} />
        {message.isStreaming && <span className="agnt-cursor-blink" aria-hidden />}
      </div>
      {!message.isStreaming && message.text && (
        <ActionPopover label="Message actions" trigger={<Ellipsis size={17} />} className="agnt-message-tools">
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
            <>
              <button
                type="button"
                className="agnt-row-action agnt-row-action-changes"
                onClick={scrollToFirstChange}
                title={`This message changed ${turnChanges.count} file${turnChanges.count === 1 ? "" : "s"} (+${turnChanges.insertions} −${turnChanges.deletions}). Click to scroll to the first file diff.`}
              >
                {turnChanges.count} file{turnChanges.count === 1 ? "" : "s"}{" "}
                <span className="agnt-gitpanel-stat-add">+{turnChanges.insertions}</span>
                {" "}
                <span className="agnt-gitpanel-stat-del">−{turnChanges.deletions}</span>
              </button>
              {connection?.rpc && thread?.cwd && changeSetRevert.phase !== "done" && (
                <button
                  type="button"
                  className="agnt-row-action"
                  onClick={handleChangeSetRevert}
                  disabled={changeSetRevert.phase === "checking" || changeSetRevert.phase === "applying"}
                  title="Reverse all file patches tied to this assistant message"
                >
                  <ArrowUturnLeft />{" "}
                  {changeSetRevert.phase === "checking"
                    ? "Checking changes..."
                    : changeSetRevert.phase === "applying"
                      ? "Reverting changes..."
                      : "Revert changes"}
                </button>
              )}
              {changeSetRevert.phase === "blocked" && (
                <span className="agnt-row-action-meta agnt-row-action-warning" title={changeSetRevert.reason}>
                  Can't revert changes — {changeSetRevert.reason}
                </span>
              )}
              {changeSetRevert.phase === "done" && (
                <span className="agnt-row-action-meta agnt-row-action-done" title="Reverse-applied this message's patches">
                  Reverted {changeSetRevert.files.length || turnChanges.count} file
                  {(changeSetRevert.files.length || turnChanges.count) === 1 ? "" : "s"}
                </span>
              )}
            </>
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
        </ActionPopover>
      )}
    </div>
  );
}

function revertBlockReason(result: {
  stagedFiles: string[];
  conflicts: Array<{ file?: string; reason?: string }>;
  unsupportedReasons: string[];
}): string {
  if (result.stagedFiles.length > 0) {
    return `Unstage ${result.stagedFiles.length} file${result.stagedFiles.length === 1 ? "" : "s"} first.`;
  }
  if (result.conflicts.length > 0) return "Conflicts with later edits.";
  return result.unsupportedReasons[0] ?? "Bridge can't reverse these patches.";
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/(["\\])/g, "\\$1");
}
