// Cross-thread search modal. ⌘/Ctrl+K opens it; typing filters across all
// cached threads' messages (the same `searchableText` helper that powers the
// in-thread search). Selecting a hit jumps the user into that thread and
// re-runs in-thread search to scroll to the message.
//
// Keeping it in `shared/` rather than `chat/` because the same affordance
// could grow into a generic command palette later (run slash commands, jump
// to settings, etc.) without needing a rename.

import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyMatch } from "../../lib/fuzzy-match";
import { searchableText } from "../chat/ThreadSearchBar";
import type { CodexMessage } from "../../models";
import { useBookmarksStore } from "../../state/bookmarks-store";
import { useThreadsStore } from "../../state/threads-store";
import { prefsStore } from "../../storage/prefs-store";
import { Xmark } from "./Icon";
import { Sheet } from "./Sheet";

interface CommandPaletteProps {
  open: boolean;
  onClose(): void;
}

interface Hit {
  threadId: string;
  threadLabel: string;
  message: CodexMessage;
  snippet: string;
  /** Higher = better. Used to sort hits across threads so fuzzy / substring
   *  scores can intermingle in a sensible order. */
  score: number;
}

const MAX_HITS = 80;
const SNIPPET_RADIUS = 60;

const MAX_SAVED_SEARCHES = 8;

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [starredOnly, setStarredOnly] = useState(false);
  const [savedSearches, setSavedSearches] = useState<string[]>([]);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const threads = useThreadsStore((state) => state.threads);
  const archived = useThreadsStore((state) => state.archivedThreads);
  const reducerStates = useThreadsStore((state) => state.reducerStates);
  const selectThread = useThreadsStore((state) => state.selectThread);
  const bookmarksByThread = useBookmarksStore((state) => state.byThread);
  const totalBookmarks = useMemo(
    () => Object.values(bookmarksByThread).reduce((sum, set) => sum + set.size, 0),
    [bookmarksByThread]
  );

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    setQuery("");
    setCursor(0);
    setStarredOnly(false);
    void prefsStore.loadSavedSearches().then(setSavedSearches);
    void prefsStore.loadRecentSearches().then(setRecentSearches);
  }, [open]);

  const MAX_RECENT = 8;
  function recordRecent(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    const next = [trimmed, ...recentSearches.filter((entry) => entry !== trimmed)].slice(0, MAX_RECENT);
    setRecentSearches(next);
    void prefsStore.saveRecentSearches(next);
  }
  function clearRecent() {
    setRecentSearches([]);
    void prefsStore.saveRecentSearches([]);
  }

  function persistSearches(next: string[]) {
    setSavedSearches(next);
    void prefsStore.saveSavedSearches(next);
  }
  function saveCurrent() {
    const trimmed = query.trim();
    if (!trimmed) return;
    if (savedSearches.includes(trimmed)) return;
    persistSearches([trimmed, ...savedSearches].slice(0, MAX_SAVED_SEARCHES));
  }
  function removeSearch(value: string) {
    persistSearches(savedSearches.filter((entry) => entry !== value));
  }
  function applySaved(value: string) {
    setQuery(value);
    inputRef.current?.focus();
  }
  const canSave = query.trim().length > 0 && !savedSearches.includes(query.trim());

  const hits: Hit[] = useMemo(() => {
    if (!open) return [];
    const trimmed = query.trim().toLowerCase();
    // The "starred only" mode walks bookmarks even when the query is empty
    // — that's the whole point of the global star list view.
    if (!trimmed && !starredOnly) return [];
    const labelByThread = new Map<string, string>();
    for (const thread of threads) labelByThread.set(thread.id, thread.name ?? thread.title ?? "Untitled");
    for (const thread of archived) labelByThread.set(thread.id, thread.name ?? thread.title ?? "Untitled (archived)");
    const out: Hit[] = [];
    for (const [threadId, reducer] of Object.entries(reducerStates)) {
      const label = labelByThread.get(threadId);
      // Skip threads we no longer know about (sidebar may have purged them)
      // — surfacing a hit we can't navigate to would be confusing.
      if (!label) continue;
      const threadBookmarks = bookmarksByThread[threadId];
      if (starredOnly && !threadBookmarks) continue;
      for (const message of reducer.messages) {
        if (starredOnly && !threadBookmarks?.has(message.id)) continue;
        const haystack = searchableText(message);
        if (!haystack) continue;
        let snippetOffset = 0;
        let snippetLength = Math.min(haystack.length, 80);
        let score = 0;
        if (trimmed) {
          // Substring match wins on score (it's the most precise) but we
          // fall back to fuzzy subsequence so typos / partial recall still
          // surface results. Both produce a snippet anchored at the match.
          const lowerHaystack = haystack.toLowerCase();
          const offset = lowerHaystack.indexOf(trimmed);
          if (offset >= 0) {
            snippetOffset = offset;
            snippetLength = trimmed.length;
            // Substring matches get a flat high score so they always sort
            // above fuzzy hits (substring is a strict superset of fuzzy).
            score = 10_000 + (haystack.length - offset);
          } else {
            const fuzzy = fuzzyMatch(trimmed, haystack);
            if (!fuzzy) continue;
            snippetOffset = fuzzy.indexes[0] ?? 0;
            snippetLength = (fuzzy.indexes[fuzzy.indexes.length - 1] ?? 0) - snippetOffset + 1;
            score = fuzzy.score;
          }
        }
        out.push({
          threadId,
          threadLabel: label,
          message,
          snippet: extractSnippet(haystack, snippetOffset, snippetLength),
          score,
        });
        if (out.length >= MAX_HITS) break;
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.length > MAX_HITS ? out.slice(0, MAX_HITS) : out;
  }, [open, query, starredOnly, threads, archived, reducerStates, bookmarksByThread]);

  // Clamp the cursor whenever the hit list shrinks; otherwise Enter could
  // run a stale selection.
  useEffect(() => {
    if (hits.length === 0) return;
    setCursor((current) => Math.min(current, hits.length - 1));
  }, [hits.length]);

  function commit(hit: Hit) {
    recordRecent(query);
    onClose();
    void selectThread(hit.threadId);
  }

  if (!open) return null;
  return (
    <Sheet open onClose={onClose} ariaLabel="Search across all threads" maxWidth={640}>
      <div className="agnt-command-palette">
        <div className="agnt-command-palette-input-row">
          <input
            ref={inputRef}
            type="search"
            className="agnt-command-palette-input"
            placeholder={starredOnly ? "Filter your starred messages…" : "Search across all threads…"}
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
          <button
            type="button"
            className="agnt-button-ghost"
            onClick={saveCurrent}
            disabled={!canSave}
            title={canSave ? "Save this search" : "Already saved or empty"}
            aria-label="Save current search"
          >
            Save
          </button>
          <button
            type="button"
            className={"agnt-button-ghost" + (starredOnly ? " agnt-button-ghost-active" : "")}
            onClick={() => setStarredOnly((current) => !current)}
            disabled={!starredOnly && totalBookmarks === 0}
            title={starredOnly ? "Show every cached message" : "Filter to starred messages only"}
            aria-pressed={starredOnly}
          >
            {starredOnly ? "★ all" : `☆ ${totalBookmarks}`}
          </button>
        </div>
        {savedSearches.length > 0 && (
          <div className="agnt-command-palette-saved" aria-label="Saved searches">
            {savedSearches.map((value) => (
              <span key={value} className="agnt-command-palette-saved-chip">
                <button
                  type="button"
                  className="agnt-command-palette-saved-apply"
                  onClick={() => applySaved(value)}
                  title={`Apply saved search: ${value}`}
                >
                  {value}
                </button>
                <button
                  type="button"
                  className="agnt-command-palette-saved-remove"
                  onClick={() => removeSearch(value)}
                  aria-label={`Forget saved search: ${value}`}
                  title="Forget"
                >
                  <Xmark size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="agnt-command-palette-hits">
          {!query.trim() && !starredOnly ? (
            recentSearches.length > 0 ? (
              <div className="agnt-command-palette-recent">
                <div className="agnt-command-palette-recent-header">
                  <span>Recent</span>
                  <button
                    type="button"
                    className="agnt-command-palette-recent-clear"
                    onClick={clearRecent}
                    aria-label="Clear recent searches"
                  >
                    Clear
                  </button>
                </div>
                {recentSearches.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="agnt-command-palette-recent-item"
                    onClick={() => {
                      setQuery(value);
                      inputRef.current?.focus();
                    }}
                  >
                    {value}
                  </button>
                ))}
              </div>
            ) : (
              <div className="agnt-command-palette-empty">Type to search every cached thread.</div>
            )
          ) : hits.length === 0 ? (
            <div className="agnt-command-palette-empty">
              {starredOnly
                ? totalBookmarks === 0
                  ? "No starred messages yet. Use the ☆ on a row to start a list."
                  : "No starred messages match that query."
                : "No matches in your cached threads."}
            </div>
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
    </Sheet>
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
