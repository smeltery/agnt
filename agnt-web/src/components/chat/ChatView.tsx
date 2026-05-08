import { useCallback, useState } from "react";
import { useShortcut } from "../../lib/keyboard";
import { useStickyScroll } from "../../lib/sticky-scroll";
import { fractionUsed } from "../../models";
import { useConnectionStore } from "../../state/connection-store";
import {
  selectActiveMessages,
  selectActiveTurnRunning,
  useThreadsStore,
} from "../../state/threads-store";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer";
import { MessageRow } from "./rows";
import { ThreadSearchBar } from "./ThreadSearchBar";
import { TurnFlagBar } from "./TurnFlagBar";

const CONTEXT_WARN_FRACTION = 0.8;

export function ChatView() {
  const selectedThreadId = useThreadsStore((state) => state.selectedThreadId);
  const messages = useThreadsStore(selectActiveMessages);
  const running = useThreadsStore(selectActiveTurnRunning);
  const sendTurn = useThreadsStore((state) => state.sendTurn);
  const stopTurn = useThreadsStore((state) => state.stopTurn);
  const error = useThreadsStore((state) => state.error);
  const usage = useThreadsStore((state) =>
    selectedThreadId ? state.contextUsageByThread[selectedThreadId] : undefined
  );
  const connection = useConnectionStore((state) => state.connection);
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

  const { scrollRef, showJumpButton, jumpToBottom } = useStickyScroll([messages, running]);

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
        messages={messages}
        onClose={() => setSearchOpen(false)}
        onScrollToMessage={scrollMessageIntoView}
      />
      <div className="agnt-chat-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="agnt-chat-empty">
            <h2>{selectedThreadId ? "No messages yet" : "Pick a thread or start a turn"}</h2>
            <p>Type below to send a turn to the bridge's active provider.</p>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              data-message-id={message.id}
              className={highlightedMessageId === message.id ? "agnt-row-highlight" : undefined}
            >
              <MessageRow message={message} />
            </div>
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
      <TurnFlagBar />
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
