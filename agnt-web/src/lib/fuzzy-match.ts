// Lightweight fuzzy matcher for the command palette + similar surfaces.
// Scores a query against a haystack by walking both as a subsequence:
//   - every query character must appear in haystack in order
//   - matches that hit the start of words / are consecutive score higher
//   - completely-missing chars short-circuit to null (no match)
//
// We stayed dependency-free here: pulling in fzf-style libraries would
// triple the bundle and the surface is small. The scoring is intentionally
// simple; the goal is "feels like fzf" not "is fzf".

export interface FuzzyMatch {
  /** Higher = better. Negative numbers are still matches; null = no match. */
  score: number;
  /** Indices in `haystack` that the query characters lined up against. */
  indexes: number[];
}

const CHAR_BONUS = 1;
// Tuned so a consecutive run beats the same-length non-consecutive match
// even when the latter benefits from word-start bonuses on every char.
// `foobar`-vs-`foo` (3 + 12 + 16 = 31) still beats `f-o-o-bar`-vs-`foo`
// (3 + 12 + 16 − 2 = 29).
const CONSECUTIVE_BONUS = 8;
const WORD_START_BONUS = 8;
const PREFIX_BONUS = 12;
const GAP_PENALTY = -1;

/** Returns `null` when not every query character appears in order. */
export function fuzzyMatch(query: string, haystack: string): FuzzyMatch | null {
  if (!query) return { score: 0, indexes: [] };
  const q = query.toLowerCase();
  const h = haystack.toLowerCase();
  const indexes: number[] = [];
  let score = 0;
  let lastIdx = -1;
  let qi = 0;
  for (let hi = 0; hi < h.length && qi < q.length; hi += 1) {
    if (h[hi] !== q[qi]) continue;
    indexes.push(hi);
    score += CHAR_BONUS;
    if (hi === 0 && qi === 0) score += PREFIX_BONUS;
    if (hi > 0 && /[\s\-_./\\]/.test(h[hi - 1])) score += WORD_START_BONUS;
    if (lastIdx >= 0) {
      const gap = hi - lastIdx - 1;
      if (gap === 0) score += CONSECUTIVE_BONUS;
      else score += gap * GAP_PENALTY;
    }
    lastIdx = hi;
    qi += 1;
  }
  if (qi < q.length) return null;
  return { score, indexes };
}

/** Slice the haystack into highlighted vs. plain runs for rendering. The
 *  `indexes` from a `fuzzyMatch` get folded into start/length spans so the
 *  caller can wrap matched chars in `<mark>` or similar. */
export interface FuzzyHighlightSpan {
  text: string;
  matched: boolean;
}

export function highlightSpans(haystack: string, indexes: readonly number[]): FuzzyHighlightSpan[] {
  if (indexes.length === 0) return [{ text: haystack, matched: false }];
  const out: FuzzyHighlightSpan[] = [];
  let cursor = 0;
  let runStart: number | null = null;
  for (let i = 0; i <= indexes.length; i += 1) {
    const idx = indexes[i];
    const continuesRun = runStart !== null && idx === indexes[i - 1] + 1;
    if (continuesRun) continue;
    // Close the previous run, if any.
    if (runStart !== null) {
      const prevEnd = indexes[i - 1] + 1;
      out.push({ text: haystack.slice(runStart, prevEnd), matched: true });
      cursor = prevEnd;
      runStart = null;
    }
    if (idx === undefined) break;
    if (idx > cursor) out.push({ text: haystack.slice(cursor, idx), matched: false });
    runStart = idx;
  }
  if (cursor < haystack.length) {
    out.push({ text: haystack.slice(cursor), matched: false });
  }
  return out;
}
