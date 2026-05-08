// Caret-aware @-mention detector. The composer hands us the full draft +
// the caret offset; we walk backward from the caret to find an `@` that's
// at the start of a token (preceded by whitespace, start of string, or
// punctuation that wouldn't be part of an email/path). If we find one, the
// span between it and the caret is the query.
//
// We deliberately don't trigger inside an email-looking context (`name@d…`)
// because the most common false positive is users typing an email address —
// an `@` immediately after a non-space character almost always means email.

export interface MentionContext {
  /** Inclusive index of the leading `@`. */
  start: number;
  /** Exclusive index where the query token ends (== caret offset). */
  end: number;
  /** The text between `@` and the caret (may be empty). */
  query: string;
}

/** Returns mention context if the caret is currently inside a `@token`. */
export function detectMention(text: string, caret: number): MentionContext | null {
  if (caret <= 0 || caret > text.length) return null;
  // Walk back to find the nearest `@`. Stop at whitespace because that ends
  // the token. Bail if we find a different `@` first (nested doesn't apply).
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "@") break;
    // Whitespace inside the token kills the match — `@foo bar` should not
    // continue mentioning when caret lands on `bar`.
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  if (i < 0 || text[i] !== "@") return null;
  // Email-style: a non-whitespace character before the `@` means this is
  // probably `name@host` not a mention. Allow `@` only at start-of-string,
  // after whitespace, or after a few opener characters that show up at the
  // start of a sentence (parens / quotes / brackets).
  if (i > 0) {
    const prev = text[i - 1];
    if (!/[\s(\[{"']/.test(prev)) return null;
  }
  return { start: i, end: caret, query: text.slice(i + 1, caret) };
}

/**
 * Build a draft after the user picks a mention target. Replaces the
 * `[start, end)` span with `replacement` and returns the new caret position
 * (just past the replacement, with a trailing space so the next keystroke
 * doesn't immediately re-open the picker).
 */
export function applyMentionReplacement(
  text: string,
  context: MentionContext,
  replacement: string
): { text: string; caret: number } {
  const insert = `${replacement} `;
  const next = text.slice(0, context.start) + insert + text.slice(context.end);
  return { text: next, caret: context.start + insert.length };
}
