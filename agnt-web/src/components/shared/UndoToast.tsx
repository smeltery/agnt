// Bottom-of-screen toast that appears whenever the undo store has an active
// entry. Click "Undo" to fire the captured reverse callback; the toast
// auto-dismisses when the entry's window expires.

import { useUndoStore } from "../../state/undo-store";
import { Xmark } from "./Icon";

export function UndoToast() {
  const entry = useUndoStore((state) => state.entry);
  const perform = useUndoStore((state) => state.perform);
  const dismiss = useUndoStore((state) => state.dismiss);
  if (!entry) return null;
  return (
    <div className="agnt-undo-toast" role="status" aria-live="polite">
      <span className="agnt-undo-toast-label">{entry.label}</span>
      <button
        type="button"
        className="agnt-undo-toast-action"
        onClick={() => void perform(entry.id)}
      >
        Undo
      </button>
      <button
        type="button"
        className="agnt-undo-toast-dismiss"
        onClick={() => dismiss(entry.id)}
        aria-label="Dismiss"
        title="Dismiss"
      >
        <Xmark size={14} />
      </button>
    </div>
  );
}
