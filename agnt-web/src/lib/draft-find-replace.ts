// Draft find/replace primitives. Pure so the composer's keyboard wiring can
// stay focused on UX, and the replacement math stays unit-testable.
//
// Matching is plain case-insensitive substring — no regex (a stray `(` from
// a user's draft shouldn't crash the bar) and no whole-word toggle (would
// spawn another control without much real value).

export interface FindMatchPosition {
  start: number;
  end: number;
}

/** Locate every occurrence of `needle` in `haystack` (case-insensitive). */
export function findAllOccurrences(haystack: string, needle: string): FindMatchPosition[] {
  if (!needle) return [];
  const out: FindMatchPosition[] = [];
  const lowerHay = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let cursor = 0;
  while (cursor <= lowerHay.length - lowerNeedle.length) {
    const index = lowerHay.indexOf(lowerNeedle, cursor);
    if (index < 0) break;
    out.push({ start: index, end: index + lowerNeedle.length });
    // Advance past this match. We don't allow overlapping matches because a
    // replace step would otherwise rewrite the same span twice.
    cursor = index + lowerNeedle.length;
  }
  return out;
}

/** Replace a single match span with `replacement`. */
export function replaceAt(text: string, position: FindMatchPosition, replacement: string): string {
  return text.slice(0, position.start) + replacement + text.slice(position.end);
}

/** Replace every occurrence of `needle` in `text` with `replacement`. */
export function replaceAll(text: string, needle: string, replacement: string): { text: string; count: number } {
  if (!needle) return { text, count: 0 };
  const matches = findAllOccurrences(text, needle);
  if (matches.length === 0) return { text, count: 0 };
  // Walk back-to-front so earlier indices don't shift under us.
  let next = text;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    next = replaceAt(next, matches[i], replacement);
  }
  return { text: next, count: matches.length };
}
