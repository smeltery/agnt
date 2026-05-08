import { useEffect, useRef } from "react";
import { fractionUsed } from "../../models";
import {
  selectActiveMessages,
  selectActiveTurnRunning,
  useThreadsStore,
} from "../../state/threads-store";
import { Composer } from "./Composer";
import { MessageRow } from "./rows";
import { TurnFlagBar } from "./TurnFlagBar";

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
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, running]);

  return (
    <main className="agnt-chat">
      {usage && (
        <div className="agnt-context-bar" title={`${usage.tokensUsed.toLocaleString()} / ${usage.tokenLimit.toLocaleString()} tokens used`}>
          <div className="agnt-context-bar-fill" style={{ width: `${(fractionUsed(usage) * 100).toFixed(0)}%` }} />
        </div>
      )}
      <div className="agnt-chat-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="agnt-chat-empty">
            <h2>{selectedThreadId ? "No messages yet" : "Pick a thread or start a turn"}</h2>
            <p>Type below to send a turn to the bridge's active provider.</p>
          </div>
        ) : (
          messages.map((message) => <MessageRow key={message.id} message={message} />)
        )}
        {error && <div className="agnt-chat-error">{error}</div>}
      </div>
      <TurnFlagBar />
      <Composer
        running={running}
        onSend={(text) => {
          if (!selectedThreadId) return;
          void sendTurn(selectedThreadId, text);
        }}
        onStop={() => void stopTurn()}
      />
    </main>
  );
}
