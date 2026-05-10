// High-contrast preference store. Orthogonal to theme — the user can
// have light + high-contrast, dark + high-contrast, or either at default
// contrast. We follow the system `prefers-contrast: more` query when the
// user hasn't made an explicit pick (the persisted state is the explicit
// override; absence means "follow system").
//
// Layered model: theme picks the palette (data-theme), contrast bumps
// borders + text weight on top (data-contrast). CSS handles the actual
// overrides.

import { create } from "zustand";
import { applyHighContrastToDocument, prefsStore } from "../storage/prefs-store";

interface State {
  /** True when the user has explicitly opted in via Settings. */
  enabled: boolean;
  /** True when the system reports `prefers-contrast: more` AND the user
   *  has not explicitly opted out. */
  systemPrefers: boolean;
  hydrated: boolean;
  hydrate(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
}

function readSystemContrast(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-contrast: more)").matches;
}

export const useContrastStore = create<State>((set, get) => ({
  enabled: false,
  systemPrefers: readSystemContrast(),
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return;
    const persisted = await prefsStore.loadHighContrast();
    const systemPrefers = readSystemContrast();
    // Apply on hydrate so a refresh doesn't flash the default contrast
    // before our useEffect runs. The persisted explicit pick wins; in
    // absence of one we follow the system query.
    const effective = persisted || systemPrefers;
    applyHighContrastToDocument(effective);
    set({ enabled: persisted, systemPrefers, hydrated: true });

    // Live-track the system setting so a user toggling
    // `prefers-contrast: more` at the OS level sees the bump without a
    // reload (matches the theme-store's auto-mode behavior).
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      const mq = window.matchMedia("(prefers-contrast: more)");
      const onChange = (event: MediaQueryListEvent) => {
        const next = event.matches;
        const current = get().enabled || next;
        applyHighContrastToDocument(current);
        set({ systemPrefers: next });
      };
      // `addEventListener` is the modern API; the old Safari fallback
      // path (addListener) was retired in Safari 14 so we don't gate it.
      mq.addEventListener("change", onChange);
    }
  },

  async setEnabled(next) {
    if (get().enabled === next) return;
    set({ enabled: next });
    applyHighContrastToDocument(next || get().systemPrefers);
    await prefsStore.saveHighContrast(next);
  },
}));
