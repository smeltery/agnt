// In-thread search. Surfaces a small bar above the chat scroll that shows a
// case-insensitive substring match count over the active thread's messages
// (joining text + command output + diff body so the visible content is what
// gets searched). Enter / shift-Enter jumps between matches by scrolling
// the message into view; the matched message gets a brief highlight class
// so users can spot it after the smooth scroll lands.
//
// We deliberately don't highlight individual matches inside a row — that
// would mean re-rendering arbitrary message content with <mark> wrapping
// which fights the existing markdown renderer. Per-message scroll-into-view
// gets us the practical 80%.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CodexMessage } from "../../models";

interface ThreadSearchBarProps {
  visible: boolean;
  messages: CodexMessage[];
  onClose(): void;
  onScrollToMessage(messageId: string): void;
}

interface Match {
  messageId: string;
}

export function ThreadSearchBar({ visible, messages, onClose, onScrollToMessage }: ThreadSearchBarProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!visible) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [visible]);

  // Reset cursor when the visible state flips so reopening doesn't surprise
  // users with a stale match index.
  useEffect(() => {
    if (!visible) setActiveIndex(0);
  }, [visible]);

  const matches: Match[] = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];
    return messages
      .filter((message) => searchableText(message).toLowerCase().includes(trimmed))
      .map((message) => ({ messageId: message.id }));
  }, [messages, query]);

  // Whenever the match set grows or shrinks, clamp activeIndex and scroll to
  // whatever it now points at — that's how the bar stays in sync with
  // streaming additions.
  useEffect(() => {
    if (matches.length === 0) return;
    const clamped = Math.min(activeIndex, matches.length - 1);
    if (clamped !== activeIndex) setActiveIndex(clamped);
    onScrollToMessage(matches[clamped].messageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches.length, activeIndex]);

  if (!visible) return null;

  function step(direction: 1 | -1) {
    if (matches.length === 0) return;
    const next = (activeIndex + direction + matches.length) % matches.length;
    setActiveIndex(next);
  }

  return (
    <div className="agnt-thread-search" role="search">
      <input
        ref={inputRef}
        type="search"
        className="agnt-thread-search-input"
        placeholder="Search this thread…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <span className="agnt-thread-search-count">
        {query.trim() === ""
          ? ""
          : matches.length === 0
            ? "no matches"
            : `${activeIndex + 1} / ${matches.length}`}
      </span>
      <button
        type="button"
        className="agnt-button-ghost"
        onClick={() => step(-1)}
        disabled={matches.length === 0}
        aria-label="Previous match"
      >
        ↑
      </button>
      <button
        type="button"
        className="agnt-button-ghost"
        onClick={() => step(1)}
        disabled={matches.length === 0}
        aria-label="Next match"
      >
        ↓
      </button>
      <button type="button" className="agnt-button-ghost" onClick={onClose} aria-label="Close search">
        ×
      </button>
    </div>
  );
}

export function searchableText(message: CodexMessage): string {
  const parts = [message.text];
  if (message.command) parts.push(message.command.fullCommand, message.command.outputTail);
  if (message.fileChange?.diff) parts.push(message.fileChange.diff);
  if (message.plan?.explanation) parts.push(message.plan.explanation);
  if (message.plan?.steps) for (const step of message.plan.steps) parts.push(step.step);
  return parts.filter(Boolean).join("\n");
}
