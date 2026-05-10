// Captures the browser's `beforeinstallprompt` event so the user can
// trigger the PWA "install app" flow from Settings instead of waiting for
// the address-bar's native prompt (which Chrome only shows once and Safari
// never shows at all).
//
// Lifecycle:
//   1. Browser fires `beforeinstallprompt` when it considers the page
//      installable. We `preventDefault` to suppress the implicit banner
//      and stash the event for later replay.
//   2. User clicks the Install button → we call `prompt()` on the stashed
//      event. The result reflects the user's choice (accepted / dismissed).
//   3. The event becomes single-use after `prompt()` resolves; we drop the
//      reference so re-clicks no-op gracefully.
//
// Safari (iOS / macOS) doesn't fire `beforeinstallprompt`. Detection is
// "the user is in standalone mode" via the matchMedia query — when true,
// we hide the install affordance entirely.

import { create } from "zustand";

export type InstallPromptState = "unsupported" | "available" | "installing" | "installed";

// The event isn't in the lib.dom yet across all TS targets; type it locally
// so the store stays self-contained.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

interface State {
  state: InstallPromptState;
  /** Triggers the native install dialog. Returns the user's choice, or
   *  null when no event is currently available. */
  promptInstall(): Promise<"accepted" | "dismissed" | null>;
  /** Subscribes to the browser's install lifecycle. Wire from `App` once;
   *  the cleanup detaches the listeners. */
  bindToBrowser(): () => void;
}

let pendingPrompt: BeforeInstallPromptEvent | null = null;

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // Safari iOS uses the legacy `navigator.standalone`; Chrome / Edge /
  // Firefox use the `display-mode: standalone` media query. We accept
  // either.
  const mq = window.matchMedia?.("(display-mode: standalone)");
  if (mq?.matches) return true;
  const legacy = (window.navigator as unknown as { standalone?: boolean }).standalone;
  return Boolean(legacy);
}

export const useInstallPromptStore = create<State>((set, get) => ({
  state: isStandalone() ? "installed" : "unsupported",

  async promptInstall() {
    const event = pendingPrompt;
    if (!event) return null;
    set({ state: "installing" });
    try {
      await event.prompt();
      const choice = await event.userChoice;
      pendingPrompt = null;
      // Whether accepted or dismissed, the event is consumed and the
      // browser won't refire it for the same session. The page itself
      // will reload into standalone mode on accept; until then we leave
      // the state at "installed" optimistically so the Install button
      // disappears even if the user is still confirming the install dialog.
      set({ state: choice.outcome === "accepted" ? "installed" : "unsupported" });
      return choice.outcome;
    } catch {
      // `prompt()` can reject if the user clicked away too fast or the
      // browser revoked permission. Restore the "available" affordance
      // so the user can try again.
      set({ state: pendingPrompt ? "available" : "unsupported" });
      return null;
    }
  },

  bindToBrowser() {
    if (typeof window === "undefined") return () => {};
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      pendingPrompt = event as BeforeInstallPromptEvent;
      if (get().state !== "installed") set({ state: "available" });
    };
    const onInstalled = () => {
      pendingPrompt = null;
      set({ state: "installed" });
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  },
}));
