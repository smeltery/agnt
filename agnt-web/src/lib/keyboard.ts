// Keyboard-shortcut helpers. Tiny, deliberately not pulling in `mousetrap` /
// `react-hotkeys` — three small hooks cover everything the workspace needs.
//
// All hooks ignore key events that originate from contenteditable, <input>,
// <textarea>, or <select> elements so users typing in the composer or search
// box don't accidentally trigger a shortcut.

import { useEffect } from "react";

type ShortcutHandler = (event: KeyboardEvent) => void;

function isTypingTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Bind a single keyboard shortcut at the window level. */
export function useShortcut(key: string, handler: ShortcutHandler, options: { skipWhenTyping?: boolean } = {}): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== key) return;
      if (options.skipWhenTyping !== false && isTypingTarget(event)) return;
      handler(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, handler, options.skipWhenTyping]);
}

/** Bind multiple key→handler entries with the same skip-when-typing behavior. */
export function useShortcuts(map: Record<string, ShortcutHandler>, options: { skipWhenTyping?: boolean } = {}): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const handler = map[event.key];
      if (!handler) return;
      if (options.skipWhenTyping !== false && isTypingTarget(event)) return;
      handler(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [map, options.skipWhenTyping]);
}
