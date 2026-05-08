// Cross-thread search modal. ⌘/Ctrl+K opens it; typing filters across all
// cached threads' messages (the same `searchableText` helper that powers the
// in-thread search). Selecting a hit jumps the user into that thread and
// re-runs in-thread search to scroll to the message.
//
// Keeping it in `shared/` rather than `chat/` because the same affordance
// could grow into a generic command palette later (run slash commands, jump
// to settings, etc.) without needing a rename.

import { useEffect, useMemo, useRef, useState } from "react";
import { searchableText } from "../chat/ThreadSearchBar";
import type { CodexMessage } from "../../models";
import { useThreadsStore } from "../../state/threads-store";

interface CommandPaletteProps {
  open: boolean;
  onClose(): void;
}

interface Hit {
  threadId: string;
  threadLabel: string;
  message: CodexMessage;
  snippet: string;
}

const MAX_HITS = 80;
const SNIPPET_RADIUS = 60;

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const threads = useThreadsStore((state) => state.threads);
  const archived = useThreadsStore((state) => state.archivedThreads);
  const reducerStates = useThreadsStore((state) => state.reducerStates);
  const selectThread = useThreadsStore((state) => state.selectThread);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    setQuery("");
    setCursor(0);
  }, [open]);

  const hits: Hit[] = useMemo(() => {
    if (!open) return [];
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];
    const labelByThread = new Map<string, string>();
    for (const thread of threads) labelByThread.set(thread.id, thread.name ?? thread.title ?? "Untitled");
    for (const thread of archived) labelByThread.set(thread.id, thread.name ?? thread.title ?? "Untitled (archived)");
    const out: Hit[] = [];
    for (const [threadId, reducer] of Object.entries(reducerStates)) {
      const label = labelByThread.get(threadId);
      // Skip threads we no longer know about (sidebar may have purged them)
      // — surfacing a hit we can't navigate to would be confusing.
      if (!label) continue;
      for (const message of reducer.messages) {
        const haystack = searchableText(message);
        if (!haystack) continue;
        const lowerHaystack = haystack.toLowerCase();
        const offset = lowerHaystack.indexOf(trimmed);
        if (offset < 0) continue;
        out.push({
          threadId,
          threadLabel: label,
          message,
          snippet: extractSnippet(haystack, offset, trimmed.length),
        });
        if (out.length >= MAX_HITS) return out;
      }
    }
    return out;
  }, [open, query, threads, archived, reducerStates]);

  // Clamp the cursor whenever the hit list shrinks; otherwise Enter could
  // run a stale selection.
  useEffect(() => {
    if (hits.length === 0) return;
    setCursor((current) => Math.min(current, hits.length - 1));
  }, [hits.length]);

  function commit(hit: Hit) {
    onClose();
    void selectThread(hit.threadId);
  }

  if (!open) return null;
  return (
    <div className="agnt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="agnt-modal agnt-command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search across all threads"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="search"
          className="agnt-command-palette-input"
          placeholder="Search across all threads…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "ArrowDown" && hits.length > 0) {
              event.preventDefault();
              setCursor((current) => (current + 1) % hits.length);
            } else if (event.key === "ArrowUp" && hits.length > 0) {
              event.preventDefault();
              setCursor((current) => (current - 1 + hits.length) % hits.length);
            } else if (event.key === "Enter" && hits.length > 0) {
              event.preventDefault();
              commit(hits[Math.min(cursor, hits.length - 1)]);
            }
          }}
        />
        <div className="agnt-command-palette-hits">
          {query.trim() === "" ? (
            <div className="agnt-command-palette-empty">Type to search every cached thread.</div>
          ) : hits.length === 0 ? (
            <div className="agnt-command-palette-empty">No matches in your cached threads.</div>
          ) : (
            hits.map((hit, index) => (
              <button
                key={`${hit.threadId}:${hit.message.id}`}
                type="button"
                role="option"
                aria-selected={index === cursor}
                className={"agnt-command-palette-hit" + (index === cursor ? " agnt-command-palette-hit-active" : "")}
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(hit);
                }}
              >
                <span className="agnt-command-palette-hit-thread">{hit.threadLabel}</span>
                <span className="agnt-command-palette-hit-snippet">{hit.snippet}</span>
              </button>
            ))
          )}
        </div>
        <div className="agnt-command-palette-footer">
          {hits.length > 0
            ? `${cursor + 1} / ${hits.length}${hits.length === MAX_HITS ? "+" : ""}`
            : ""}
          <span className="agnt-command-palette-hint">↑↓ navigate · Enter open · Esc close</span>
        </div>
      </div>
    </div>
  );
}

function extractSnippet(text: string, matchOffset: number, matchLength: number): string {
  const start = Math.max(0, matchOffset - SNIPPET_RADIUS);
  const end = Math.min(text.length, matchOffset + matchLength + SNIPPET_RADIUS);
  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;
  return snippet;
}
