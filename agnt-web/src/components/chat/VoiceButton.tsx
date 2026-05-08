// Mic button next to the composer. Three primary states: idle (mic glyph),
// recording (live timer + pulsing red dot + click-to-stop), transcribing
// (spinner). Errors render under the mic for two seconds and clear on next
// click.

import { useEffect, useState } from "react";
import { useVoiceStore } from "../../state/voice-store";

export function VoiceButton() {
  const state = useVoiceStore((store) => store.state);
  const start = useVoiceStore((store) => store.start);
  const stop = useVoiceStore((store) => store.stop);
  const cancel = useVoiceStore((store) => store.cancel);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (state.kind !== "recording") {
      setElapsedMs(0);
      return;
    }
    const startedAt = state.startedAt;
    setElapsedMs(Date.now() - startedAt);
    const handle = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 200);
    return () => window.clearInterval(handle);
  }, [state]);

  const onClick = () => {
    if (state.kind === "idle" || state.kind === "error") void start();
    else if (state.kind === "recording") void stop();
    else if (state.kind === "transcribing") return; // blocked while transcribing
  };

  const label = (() => {
    switch (state.kind) {
      case "recording":
        return `Stop · ${formatTime(elapsedMs)}`;
      case "transcribing":
        return "Transcribing…";
      case "error":
        return "Try again";
      case "idle":
      default:
        return "Record";
    }
  })();

  return (
    <div className="agnt-voice">
      <button
        type="button"
        className={"agnt-voice-button agnt-voice-" + state.kind}
        onClick={onClick}
        disabled={state.kind === "transcribing"}
        aria-label={label}
        title={label}
      >
        {state.kind === "recording" ? <span className="agnt-voice-dot" aria-hidden /> : null}
        {state.kind === "transcribing" ? <span className="agnt-voice-spinner" aria-hidden /> : null}
        <span className="agnt-voice-glyph" aria-hidden>{state.kind === "recording" ? "■" : "●"}</span>
        <span className="agnt-voice-label">{label}</span>
      </button>
      {state.kind === "recording" && (
        <button type="button" className="agnt-voice-cancel" onClick={cancel} aria-label="Cancel recording">
          Cancel
        </button>
      )}
      {state.kind === "error" && <div className="agnt-voice-error">{state.message}</div>}
    </div>
  );
}

function formatTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
