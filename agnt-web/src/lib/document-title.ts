// Document title controller. Reflects the active thread's title so users who
// have agnt open in several tabs (or windows side-by-side) can find the right
// one in their browser's tab strip. Also drives the "incomplete turn while
// tab is hidden" flash via the same `flashTitle` exit point so we don't end
// up with two competing title writers.
//
// Design: a tiny hook + helper rather than a full store. Title state isn't
// something other parts of the app need to read.

import { useEffect } from "react";

const BASE_TITLE = "agnt";

let originalTitle: string | null = null;
// Tracks the "neutral" title that flash should fall back to once the user
// re-focuses. Driven by the hook below.
let neutralTitle: string = BASE_TITLE;
let flashTimer: ReturnType<typeof setInterval> | null = null;
let flashState: "neutral" | "alert" = "neutral";
const FLASH_INTERVAL_MS = 1500;

export function useDocumentTitle(threadTitle: string | undefined): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (originalTitle === null) originalTitle = document.title;
    const next = threadTitle?.trim() ? `${threadTitle.trim()} · ${BASE_TITLE}` : BASE_TITLE;
    neutralTitle = next;
    if (flashTimer === null) document.title = next;
    return () => {
      // Don't reset the title on unmount of the consumer — the next mount
      // will set it. Restoring to BASE_TITLE here would create a flicker
      // when components remount across hot reloads.
    };
  }, [threadTitle]);
}

/**
 * Flash the tab title between the neutral title and an alert label until the
 * page becomes visible again. Idempotent — calling while a flash is already
 * in progress just refreshes the alert label. Stops automatically on
 * `visibilitychange` once the user comes back.
 */
export function flashTitle(alert: string): void {
  if (typeof document === "undefined") return;
  // Only flash when the tab is hidden — focused tabs don't need a title
  // dance; the inline notice toast is enough on its own.
  if (!document.hidden) return;
  const alertTitle = `(${alert}) ${neutralTitle}`;
  if (flashTimer !== null) {
    // Already flashing — refresh the alert label so a back-to-back
    // completion doesn't lose its message in the cycle.
    if (flashState === "alert") document.title = alertTitle;
    return;
  }
  flashState = "alert";
  document.title = alertTitle;
  flashTimer = setInterval(() => {
    flashState = flashState === "alert" ? "neutral" : "alert";
    document.title = flashState === "alert" ? alertTitle : neutralTitle;
  }, FLASH_INTERVAL_MS);
  document.addEventListener("visibilitychange", stopFlashOnVisible);
}

function stopFlashOnVisible(): void {
  if (typeof document === "undefined" || document.hidden) return;
  if (flashTimer !== null) {
    clearInterval(flashTimer);
    flashTimer = null;
  }
  document.title = neutralTitle;
  document.removeEventListener("visibilitychange", stopFlashOnVisible);
}

/** Test-only escape hatch so suites can verify state without leaking timers. */
export function __resetTitleControllerForTests(): void {
  if (flashTimer !== null) {
    clearInterval(flashTimer);
    flashTimer = null;
  }
  flashState = "neutral";
  neutralTitle = BASE_TITLE;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", stopFlashOnVisible);
    document.title = originalTitle ?? BASE_TITLE;
  }
  originalTitle = null;
}
