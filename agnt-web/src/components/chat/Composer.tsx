import { useEffect, useState } from "react";
import { useVoiceStore } from "../../state/voice-store";
import { VoiceButton } from "./VoiceButton";

export interface ComposerProps {
  running: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer({ running, onSend, onStop }: ComposerProps) {
  const [draft, setDraft] = useState("");
  // Voice transcript drains on completion: when the voice-store stamps a new
  // transcript, append it (with a leading space if the draft already has text)
  // and clear the pending value. The store is the source of truth for the
  // arrival event so the composer doesn't double-apply a transcript.
  const pendingTranscript = useVoiceStore((state) => state.pendingTranscript);
  const consumeTranscript = useVoiceStore((state) => state.consumeTranscript);

  useEffect(() => {
    if (!pendingTranscript) return;
    const transcript = consumeTranscript();
    if (!transcript) return;
    setDraft((current) => (current.trim() ? `${current.trimEnd()} ${transcript}` : transcript));
  }, [pendingTranscript, consumeTranscript]);

  function submit() {
    const text = draft.trim();
    if (!text || running) return;
    onSend(text);
    setDraft("");
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    submit();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form className="agnt-composer" onSubmit={handleSubmit}>
      <textarea
        id="agnt-composer-input"
        className="agnt-composer-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Send a turn… (⌘/Ctrl+Enter)"
        rows={3}
        spellCheck={false}
      />
      <div className="agnt-composer-actions">
        <VoiceButton />
        {running ? (
          <button type="button" className="agnt-button-danger" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="agnt-button-primary" disabled={!draft.trim()}>
            Send
          </button>
        )}
      </div>
    </form>
  );
}
