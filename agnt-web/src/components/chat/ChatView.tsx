import { useEffect, useRef, useState } from "react";
import { useThreadsStore } from "../../state/threads-store";
import { TurnRow } from "./TurnRow";
import { Composer } from "./Composer";

export function ChatView() {
  const selectedThreadId = useThreadsStore((state) => state.selectedThreadId);
  const activeTurn = useThreadsStore((state) => state.activeTurn);
  const sendTurn = useThreadsStore((state) => state.sendTurn);
  const stopTurn = useThreadsStore((state) => state.stopTurn);
  const error = useThreadsStore((state) => state.error);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draftThreadId] = useState(() => `draft-${crypto.randomUUID()}`);

  const threadId = selectedThreadId ?? draftThreadId;
  const rows = activeTurn?.rows ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [rows.length]);

  return (
    <main className="agnt-chat">
      <div className="agnt-chat-scroll" ref={scrollRef}>
        {rows.length === 0 ? (
          <div className="agnt-chat-empty">
            <h2>Start a turn</h2>
            <p>Type something below. The bridge will route it to your selected provider's CLI.</p>
          </div>
        ) : (
          rows.map((row) => <TurnRow key={row.itemId} row={row} />)
        )}
        {error && <div className="agnt-chat-error">{error}</div>}
      </div>
      <Composer
        running={activeTurn?.status === "running"}
        onSend={(text) => void sendTurn(threadId, text)}
        onStop={() => void stopTurn()}
      />
    </main>
  );
}
