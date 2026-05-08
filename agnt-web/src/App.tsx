// Top-level route switch. The paired-vs-not branch lives here so individual screens
// stay dumb and don't need to know about saved-pairing hydration.

import { useEffect } from "react";
import { useBookmarksStore } from "./state/bookmarks-store";
import { useConnectionStore } from "./state/connection-store";
import { useCustomSlashCommandsStore } from "./state/custom-slash-commands-store";
import { useThemeStore } from "./state/theme-store";
import { PairingScreen } from "./components/pairing/PairingScreen";
import { Workspace } from "./components/workspace/Workspace";
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
  }, [hydrate, hydrateTheme, hydrateCustomSlash, hydrateBookmarks]);

  useEffect(() => {
    if (!bootstrapping && saved && status.kind === "idle") {
      void reconnect();
    }
  }, [bootstrapping, saved, status.kind, reconnect]);

  if (bootstrapping) return <LoadingScreen label="Loading saved pairing…" />;
  if (!saved) return <PairingScreen />;
  return <Workspace />;
}
