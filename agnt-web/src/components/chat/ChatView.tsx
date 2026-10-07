import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShortcut } from "../../lib/keyboard";
import { useStickyScroll } from "../../lib/sticky-scroll";
import type { CodexMessage } from "../../models";
import { fractionUsed } from "../../models";
import { useBookmarksStore } from "../../state/bookmarks-store";
import { useChatFocusStore } from "../../state/chat-focus-store";
import { useConnectionStore } from "../../state/connection-store";
import {
  selectActiveMessages,
  selectActiveTurnRunning,
  useThreadsStore,
} from "../../state/threads-store";
import { ArrowshapeTurnUpLeft, Star } from "../shared/Icon";
import { EmptyState } from "../shared/Loading";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer";
import { MessageRow } from "./rows";
import { ThreadSearchBar } from "./ThreadSearchBar";

const CONTEXT_WARN_FRACTION = 0.8;

export function ChatView() {
  const selectedThreadId = useThreadsStore((state) => state.selectedThreadId);
  const messages = useThreadsStore(selectActiveMessages);
  const running = useThreadsStore(selectActiveTurnRunning);
  const sendTurn = useThreadsStore((state) => state.sendTurn);
  const stopTurn = useThreadsStore((state) => state.stopTurn);
  const error = useThreadsStore((state) => state.error);
  // Arrival ts: when did the user previously view this thread? We draw
  // a "new since you were last here" divider above the first message
  // whose createdAt exceeds this. `0` (never visited / fresh thread)
  // naturally suppresses the divider since nothing is older than 0.
  const arrivalTs = useThreadsStore((state) =>
    selectedThreadId ? state.arrivalVisitedByThread[selectedThreadId] ?? 0 : 0
  );
  const usage = useThreadsStore((state) =>
    selectedThreadId ? state.contextUsageByThread[selectedThreadId] : undefined
  );
  const connection = useConnectionStore((state) => state.connection);
  const [searchOpen, setSearchOpen] = useState(false);
  const [starredOnly, setStarredOnly] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const bookmarks = useBookmarksStore((state) =>
    selectedThreadId ? state.byThread[selectedThreadId] : undefined
  );

  // When the starred filter is on, hide non-bookmarked rows from the
  // timeline. Search hits are recomputed by the search bar against the same
  // (already-filtered) message list, so navigation stays consistent.
  const visibleMessages = useMemo(() => {
    if (!starredOnly) return messages;
    if (!bookmarks || bookmarks.size === 0) return [];
    return messages.filter((message) => bookmarks.has(message.id));
  }, [messages, starredOnly, bookmarks]);

  // First message id with a createdAt newer than the prior visit. Null
  // when the user has nothing new (or the threshold is 0). We anchor on
  // an id (not an index) so streaming-driven re-orders don't shift the
  // divider mid-paint.
  const firstNewMessageId = useMemo<string | null>(() => {
    if (arrivalTs <= 0) return null;
    for (const message of visibleMessages) {
      if (message.createdAt > arrivalTs) return message.id;
    }
    return null;
  }, [visibleMessages, arrivalTs]);

  const { scrollRef, showJumpButton, jumpToBottom } = useStickyScroll([visibleMessages, running]);

  // Ctrl/⌘+F (and bare `f` outside inputs) toggles the search bar so users
  // can find anything in a long thread without leaning on browser native
  // search (which finds chrome too and isn't aware of streaming rows).
  useShortcut(
    "f",
    (event) => {
      if (!(event.metaKey || event.ctrlKey)) {
        // Bare `f` only fires when not typing — useShortcut already gates that.
        setSearchOpen(true);
        return;
      }
      // Ctrl+F / ⌘+F: hijack the browser shortcut so our search wins.
      event.preventDefault();
      setSearchOpen(true);
    },
    { skipWhenTyping: false }
  );

  // `[` / `]` jump between user messages — Vim-style navigation through a
  // long thread without scrolling. `]` steps forward (toward the latest),
  // `[` steps back. The cursor is anchored on whichever user row is closest
  // to the current viewport mid-line so successive presses make progress
  // even if the user scrolled in between.
  function stepBetweenUserMessages(direction: 1 | -1) {
    const userRows = visibleMessages.filter((message) => message.role === "user");
    if (userRows.length === 0) return;
    const currentIndex = findClosestUserIndex(userRows, scrollRef.current);
    let nextIndex: number;
    if (currentIndex < 0) {
      nextIndex = direction === 1 ? 0 : userRows.length - 1;
    } else {
      nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= userRows.length) return;
    }
    scrollMessageIntoView(userRows[nextIndex].id);
  }
  useShortcut("[", () => stepBetweenUserMessages(-1));
  useShortcut("]", () => stepBetweenUserMessages(1));

  // Vim-style jump-to-top (`gg`, double-press within 600ms) and jump-to-
  // bottom (`G`). The double-press window is short enough that an accidental
  // single `g` doesn't accumulate forever, but long enough to feel natural.
  const lastGAtRef = useRef(0);
  useShortcut("g", () => {
    const now = Date.now();
    if (now - lastGAtRef.current < 600) {
      lastGAtRef.current = 0;
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    lastGAtRef.current = now;
  });
  useShortcut("G", () => {
    jumpToBottom();
  });

  const scrollMessageIntoView = useCallback(
    (messageId: string) => {
      const node = scrollRef.current?.querySelector(`[data-message-id="${cssEscape(messageId)}"]`);
      if (!node || !(node instanceof HTMLElement)) return;
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightedMessageId(messageId);
      window.setTimeout(() => {
        setHighlightedMessageId((current) => (current === messageId ? null : current));
      }, 1500);
    },
    [scrollRef]
  );

  // Deep-link follow-up: when Workspace queued a `messageId` for this thread
  // (parsed from `#thread/.../message/<id>`), wait until the matching row is
  // actually in the DOM before scrolling — messages arrive async via
  // selectThread + reducer hydration.
  const pendingFocus = useChatFocusStore((state) => state.pendingMessageId);
  useEffect(() => {
    if (!selectedThreadId || !pendingFocus) return;
    if (pendingFocus.threadId !== selectedThreadId) return;
    if (!visibleMessages.some((message) => message.id === pendingFocus.messageId)) return;
    const messageId = useChatFocusStore.getState().consume(selectedThreadId);
    if (!messageId) return;
    // Defer one frame so the row's layout has settled.
    requestAnimationFrame(() => scrollMessageIntoView(messageId));
  }, [selectedThreadId, pendingFocus, visibleMessages, scrollMessageIntoView]);

  const overWarn = usage ? fractionUsed(usage) >= CONTEXT_WARN_FRACTION : false;

  return (
    <main className="agnt-chat">
      <ChatHeader rpc={connection?.rpc ?? null} />
      {usage && (
        <div
          className={"agnt-context-bar" + (overWarn ? " agnt-context-bar-warn" : "")}
          title={`${usage.tokensUsed.toLocaleString()} / ${usage.tokenLimit.toLocaleString()} tokens used`}
        >
          <div className="agnt-context-bar-fill" style={{ width: `${(fractionUsed(usage) * 100).toFixed(0)}%` }} />
        </div>
      )}
      {overWarn && usage && (
        <div className="agnt-context-warning" role="status">
          Context window {Math.round(fractionUsed(usage) * 100)}% used. Consider compacting older turns from the sidebar context menu.
        </div>
      )}
      <ThreadSearchBar
        visible={searchOpen}
        messages={visibleMessages}
        threadId={selectedThreadId}
        starredOnly={starredOnly}
        onClose={() => setSearchOpen(false)}
        onScrollToMessage={scrollMessageIntoView}
        onToggleStarredOnly={() => setStarredOnly((current) => !current)}
      />
      {starredOnly && (
        <div className="agnt-chat-filter-banner" role="status">
          Showing starred messages only · {visibleMessages.length} of {messages.length}
          <button type="button" className="agnt-button-ghost" onClick={() => setStarredOnly(false)}>
            Show all
          </button>
        </div>
      )}
      <div className="agnt-chat-scroll" ref={scrollRef}>
        {visibleMessages.length === 0 ? (
          <EmptyState
            icon={starredOnly && messages.length > 0
              ? <Star size={22} />
              : <ArrowshapeTurnUpLeft size={22} />}
            title={
              starredOnly && messages.length > 0
                ? "No starred messages in this thread"
                : selectedThreadId
                  ? "No messages yet"
                  : "Pick a thread or start a turn"
            }
            message={
              starredOnly && messages.length > 0
                ? undefined
                : selectedThreadId
                  ? "Type below to send a turn to the bridge's active provider."
                  : "Open a thread from the sidebar, or tap + New."
            }
          />
        ) : (
          visibleMessages.map((message) => (
            <Fragment key={message.id}>
              {firstNewMessageId === message.id && (
                <div className="agnt-chat-new-divider" role="separator" aria-label="New messages">
                  <span>New since you were last here</span>
                </div>
              )}
              <div
                data-message-id={message.id}
                // `agnt-msg-cv` opts each row into CSS `content-visibility:
                // auto`, so off-screen rows skip layout + paint entirely.
                // Browser-native virtualization — no JS overhead, no library,
                // no scroll-position math. The intrinsic-size hint keeps
                // scroll height stable while rows are skipped.
                className={
                  "agnt-msg-cv"
                  + (highlightedMessageId === message.id ? " agnt-row-highlight" : "")
                }
              >
                <MessageRow message={message} />
              </div>
            </Fragment>
          ))
        )}
        {error && <div className="agnt-chat-error">{error}</div>}
      </div>
      {showJumpButton && (
        <button
          type="button"
          className="agnt-chat-jump"
          onClick={jumpToBottom}
          aria-label="Jump to latest message"
          title="Jump to latest"
        >
          ↓ Latest
        </button>
      )}
      <Composer
        running={running}
        onSend={(text, attachments) => {
          if (!selectedThreadId) return;
          void sendTurn(selectedThreadId, text, attachments);
        }}
        onStop={() => void stopTurn()}
      />
    </main>
  );
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/(["\\])/g, "\\$1");
}

/**
 * Walk the user-row list and pick whichever id is closest to the viewport's
 * mid-line. `[` and `]` step from there. Returns -1 when no row is on
 * screen (e.g. the user scrolled past the entire thread); the caller treats
 * that as "start from the boundary."
 */
function findClosestUserIndex(userRows: CodexMessage[], scrollContainer: HTMLElement | null): number {
  if (!scrollContainer || userRows.length === 0) return -1;
  const viewportMid = scrollContainer.getBoundingClientRect().top + scrollContainer.clientHeight / 2;
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  userRows.forEach((message, index) => {
    const node = scrollContainer.querySelector(`[data-message-id="${cssEscape(message.id)}"]`);
    if (!(node instanceof HTMLElement)) return;
    const rect = node.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    const distance = Math.abs(center - viewportMid);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}
