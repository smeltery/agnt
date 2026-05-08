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
import { useBookmarksStore } from "../../state/bookmarks-store";

interface ThreadSearchBarProps {
  visible: boolean;
  messages: CodexMessage[];
  /** Active thread id; used to scope the bookmark filter. */
  threadId: string | null;
  /** When true, only matches whose message id is bookmarked count as hits. */
  starredOnly: boolean;
  onClose(): void;
  onScrollToMessage(messageId: string): void;
  onToggleStarredOnly(): void;
}

interface Match {
  messageId: string;
}

export function ThreadSearchBar({
  visible,
  messages,
  threadId,
  starredOnly,
  onClose,
  onScrollToMessage,
  onToggleStarredOnly,
}: ThreadSearchBarProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const bookmarks = useBookmarksStore((state) =>
    threadId ? state.byThread[threadId] : undefined
  );
  const bookmarkCount = bookmarks?.size ?? 0;

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
    // Empty query + no star filter = no matches (search is idle).
    // Empty query + star filter = matches are every starred message in order.
    if (!trimmed && !starredOnly) return [];
    return messages
      .filter((message) => {
        if (starredOnly && !bookmarks?.has(message.id)) return false;
        if (!trimmed) return true;
        return searchableText(message).toLowerCase().includes(trimmed);
      })
      .map((message) => ({ messageId: message.id }));
  }, [messages, query, starredOnly, bookmarks]);

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
        {!query.trim() && !starredOnly
          ? ""
          : matches.length === 0
            ? "no matches"
            : `${activeIndex + 1} / ${matches.length}`}
      </span>
      <button
        type="button"
        className={"agnt-button-ghost" + (starredOnly ? " agnt-button-ghost-active" : "")}
        onClick={onToggleStarredOnly}
        title={starredOnly ? "Show all messages" : "Show starred messages only"}
        aria-pressed={starredOnly}
        disabled={!starredOnly && bookmarkCount === 0}
      >
        {starredOnly ? "★ all" : `☆ ${bookmarkCount}`}
      </button>
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
