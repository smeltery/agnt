// Top-level route switch. The paired-vs-not branch lives here so individual screens
// stay dumb and don't need to know about saved-pairing hydration.

import { useEffect } from "react";
import { type LocaleId, SUPPORTED_LOCALES, useI18nStore } from "./lib/i18n";
import { useBookmarksStore } from "./state/bookmarks-store";
import { useConnectionStore } from "./state/connection-store";
import { useCustomSlashCommandsStore } from "./state/custom-slash-commands-store";
import { useThemeStore } from "./state/theme-store";
import { prefsStore } from "./storage/prefs-store";
import { PairingScreen } from "./components/pairing/PairingScreen";
import { Workspace } from "./components/workspace/Workspace";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { LoadingScreen } from "./components/shared/LoadingScreen";

export function App() {
  const bootstrapping = useConnectionStore((state) => state.bootstrapping);
  const saved = useConnectionStore((state) => state.saved);
  const status = useConnectionStore((state) => state.status);
  const hydrate = useConnectionStore((state) => state.hydrate);
  const hydrateTheme = useThemeStore((state) => state.hydrate);
  const hydrateCustomSlash = useCustomSlashCommandsStore((state) => state.hydrate);
  const hydrateBookmarks = useBookmarksStore((state) => state.hydrate);
  const reconnect = useConnectionStore((state) => state.reconnect);

  useEffect(() => {
    // Theme hydrates first to avoid a flash of wrong palette.
    void hydrateTheme().then(() => hydrate());
    // Background prefs load whenever idb gets around to it — they don't
    // block the critical render path.
    void hydrateCustomSlash();
    void hydrateBookmarks();
    // Locale: prefer the persisted pick over the browser default. Falls
    // back to the navigator-derived initial state set by the i18n store.
    void prefsStore.loadLocale().then((persisted) => {
      if (!persisted) return;
      const valid = SUPPORTED_LOCALES.find((option) => option.id === (persisted as LocaleId));
      if (valid) useI18nStore.getState().setLocale(valid.id);
    });
  }, [hydrate, hydrateTheme, hydrateCustomSlash, hydrateBookmarks]);

  useEffect(() => {
    if (!bootstrapping && saved && status.kind === "idle") {
      void reconnect();
    }
  }, [bootstrapping, saved, status.kind, reconnect]);

  // ErrorBoundary wraps the whole tree so a render-time crash anywhere in
  // a downstream component surfaces as a recoverable card instead of a
  // blank page. Effects above keep firing because state survives — the
  // user can hit "Try again" and the next render uses the new state.
  return (
    <ErrorBoundary>
      {bootstrapping
        ? <LoadingScreen label="Loading saved pairing…" />
        : !saved
          ? <PairingScreen />
          : <Workspace />}
    </ErrorBoundary>
  );
}
