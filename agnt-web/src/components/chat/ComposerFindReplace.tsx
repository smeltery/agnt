// Find/replace bar above the composer textarea. Lives in its own file
// because Composer.tsx is already busy and the find/replace state has its
// own little state machine (typing the needle re-runs the search; pressing
// Replace advances; Replace-all rewrites in one shot).

import { useEffect, useMemo, useRef, useState } from "react";
import { findAllOccurrences, replaceAll, replaceAt, type FindMatchPosition } from "../../lib/draft-find-replace";

interface ComposerFindReplaceProps {
  textarea: HTMLTextAreaElement | null;
  draft: string;
  onChange(next: string): void;
  onClose(): void;
}

export function ComposerFindReplace({ textarea, draft, onChange, onClose }: ComposerFindReplaceProps) {
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);

  const matches: FindMatchPosition[] = useMemo(() => {
    if (!findText) return [];
    return findAllOccurrences(draft, findText);
  }, [draft, findText]);

  // Keep the cursor inside the match list as the draft mutates underneath us
  // (Replace advances the cursor; Replace-all collapses to zero matches).
  useEffect(() => {
    if (matches.length === 0) {
      setActiveIndex(0);
      return;
    }
    setActiveIndex((current) => Math.min(current, matches.length - 1));
  }, [matches.length]);

  // Focus the find input when the bar mounts so the user can start typing
  // immediately without an extra click.
  useEffect(() => {
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, []);

  function highlightMatch(position: FindMatchPosition) {
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(position.start, position.end);
  }

  function step(direction: 1 | -1) {
    if (matches.length === 0) return;
    const next = (activeIndex + direction + matches.length) % matches.length;
    setActiveIndex(next);
    highlightMatch(matches[next]);
  }

  function replaceCurrent() {
    if (matches.length === 0) return;
    const target = matches[Math.min(activeIndex, matches.length - 1)];
    const nextDraft = replaceAt(draft, target, replaceText);
    onChange(nextDraft);
    // Park the caret at the end of the replacement on the next paint.
    requestAnimationFrame(() => {
      if (!textarea) return;
      const caret = target.start + replaceText.length;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  }

  function replaceAllOccurrences() {
    if (matches.length === 0) return;
    const result = replaceAll(draft, findText, replaceText);
    if (result.count === 0) return;
    onChange(result.text);
  }

  return (
    <div className="agnt-composer-findreplace" role="search" aria-label="Find and replace in draft">
      <input
        ref={findInputRef}
        type="search"
        className="agnt-composer-findreplace-input"
        placeholder="Find"
        value={findText}
        onChange={(event) => setFindText(event.target.value)}
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
      <input
        type="text"
        className="agnt-composer-findreplace-input"
        placeholder="Replace"
        value={replaceText}
        onChange={(event) => setReplaceText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            replaceCurrent();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <span className="agnt-composer-findreplace-count">
        {findText === "" ? "" : matches.length === 0 ? "no matches" : `${activeIndex + 1} / ${matches.length}`}
      </span>
      <button type="button" className="agnt-button-ghost" onClick={() => step(-1)} disabled={matches.length === 0} aria-label="Previous match">↑</button>
      <button type="button" className="agnt-button-ghost" onClick={() => step(1)} disabled={matches.length === 0} aria-label="Next match">↓</button>
      <button type="button" className="agnt-button-ghost" onClick={replaceCurrent} disabled={matches.length === 0}>
        Replace
      </button>
      <button type="button" className="agnt-button-ghost" onClick={replaceAllOccurrences} disabled={matches.length === 0}>
        All
      </button>
      <button type="button" className="agnt-button-ghost" onClick={onClose} aria-label="Close find/replace">×</button>
    </div>
  );
}
