// Linear/Gmail-style "undo destructive action" surface. When an action like
// archive/rename publishes a reversal callback here, the UI shows a toast
// with an Undo button that fires the callback if clicked within the window.
//
// Single-slot by design — at most one undo target at a time. A second
// publish replaces the first (the older action's window has effectively
// "ended" once the user did something new).

import { create } from "zustand";

export interface UndoEntry {
  /** Stable id so the toast can render keyed and tests can assert. */
  id: string;
  /** Short user-facing label, e.g. `Archived "feature-x"`. */
  label: string;
  /** Fired if the user clicks Undo before the window expires. */
  reverse(): Promise<void> | void;
  /** Local epoch ms when the entry was published. */
  publishedAtMs: number;
  /** How long the undo window stays open. Default 5 seconds. */
  durationMs: number;
}

interface State {
  entry: UndoEntry | null;
  /** Publish a new undo entry. Replaces any prior unconsumed entry. */
  publish(input: { label: string; reverse: () => Promise<void> | void; durationMs?: number }): string;
  /** Run the reverse callback and clear the slot. No-op if id mismatches. */
  perform(id: string): Promise<void>;
  /** Drop the entry without running the reverse (timeout / next action). */
  dismiss(id?: string): void;
}

const DEFAULT_DURATION_MS = 5_000;
let timer: ReturnType<typeof setTimeout> | null = null;

export const useUndoStore = create<State>((set, get) => ({
  entry: null,
  publish(input) {
    if (timer) clearTimeout(timer);
    const id = crypto.randomUUID();
    const durationMs = input.durationMs ?? DEFAULT_DURATION_MS;
    set({
      entry: {
        id,
        label: input.label,
        reverse: input.reverse,
        publishedAtMs: Date.now(),
        durationMs,
      },
    });
    timer = setTimeout(() => {
      // Only auto-dismiss if our entry is still the active one (a newer
      // publish would have replaced it; a manual perform/dismiss already
      // cleared it).
      const current = get().entry;
      if (current && current.id === id) set({ entry: null });
      timer = null;
    }, durationMs);
    return id;
  },
  async perform(id) {
    const entry = get().entry;
    if (!entry || entry.id !== id) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    set({ entry: null });
    try {
      await entry.reverse();
    } catch {
      // Reverse failures shouldn't crash the UI — the toast is already
      // gone, the user can re-do the action manually.
    }
  },
  dismiss(id) {
    const current = get().entry;
    if (!current) return;
    if (id && current.id !== id) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    set({ entry: null });
  },
}));

export function __resetUndoStoreForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  useUndoStore.setState({ entry: null });
}
