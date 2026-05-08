// Pure size estimators for the composer draft footer. Word count is the
// usual whitespace-split; the token estimate is the standard `chars/4`
// heuristic — close enough for an "are you bumping the context window"
// signal but explicitly approximate (we surface a `~` to make that clear).

export interface DraftStats {
  chars: number;
  words: number;
  /** Approximate token count using the chars/4 rule of thumb for English. */
  approxTokens: number;
}

export function computeDraftStats(text: string): DraftStats {
  const chars = text.length;
  const trimmed = text.trim();
  const words = trimmed === "" ? 0 : trimmed.split(/\s+/).length;
  // Round up so a 3-char draft still reports as ~1 token rather than 0 —
  // visually less confusing once content is present.
  const approxTokens = chars === 0 ? 0 : Math.max(1, Math.ceil(chars / 4));
  return { chars, words, approxTokens };
}

/** Locale-aware integer formatter — pulled out so the test can assert the
 *  output without depending on a real Intl implementation. */
export function formatCount(value: number): string {
  return value.toLocaleString();
}
