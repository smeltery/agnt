// Theme preference store. Three modes: "auto" (follow system), "light", "dark".
// On store init we load the persisted choice, write it to the documentElement,
// and start listening to prefers-color-scheme for live system swaps in auto
// mode (so a user toggling dark/light at the OS level updates the app
// without a reload).

import { create } from "zustand";
import { applyThemeToDocument, prefsStore, type ThemePreference } from "../storage/prefs-store";

interface State {
  theme: ThemePreference;
  hydrated: boolean;
  hydrate(): Promise<void>;
  setTheme(next: ThemePreference): Promise<void>;
}

export const useThemeStore = create<State>((set, get) => ({
  theme: "auto",
  hydrated: false,
  async hydrate() {
    if (get().hydrated) return;
    const theme = await prefsStore.loadTheme();
    applyThemeToDocument(theme);
    set({ theme, hydrated: true });
  },
  async setTheme(next) {
    if (get().theme === next) return;
    set({ theme: next });
    applyThemeToDocument(next);
    await prefsStore.saveTheme(next);
  },
}));
