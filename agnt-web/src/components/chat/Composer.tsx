import { useState } from "react";

export interface ComposerProps {
  running: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer({ running, onSend, onStop }: ComposerProps) {
  const [draft, setDraft] = useState("");

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
        className="agnt-composer-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Send a turn… (⌘/Ctrl+Enter)"
        rows={3}
        spellCheck={false}
      />
      <div className="agnt-composer-actions">
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
