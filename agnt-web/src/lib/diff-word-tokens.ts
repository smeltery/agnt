// Word-level intra-line diff for adjacent `-` / `+` lines in a unified diff.
// We tokenize each line into "words" (runs of word-chars), whitespace, and
// single non-word-non-space chars, then compute the longest-common-
// subsequence to mark which tokens differ. The output drives per-token
// classes in `DiffView` so a one-character rename inside a long line shows
// up as a tight highlight instead of the whole line painting red+green.
//
// Pure — exported for unit tests. Designed to run at render time on small
// hunks (a few dozen lines), not on the entire patch up front.

export type DiffWordTokenChange = "same" | "removed" | "added";

export interface DiffWordToken {
  text: string;
  change: DiffWordTokenChange;
}

export interface WordDiffResult {
  removed: DiffWordToken[];
  added: DiffWordToken[];
}

/** Splits a string into tokens used by the LCS diff. Words (`\w+`) stay
 *  intact so `foo` vs `bar` in `foo()` shows just the `foo` highlighted, not
 *  the surrounding parens. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let cursor = 0;
  const wordRe = /[\p{L}\p{N}_]+/uy;
  const wsRe = /\s+/y;
  while (cursor < line.length) {
    wordRe.lastIndex = cursor;
    const wordMatch = wordRe.exec(line);
    if (wordMatch && wordMatch.index === cursor) {
      tokens.push(wordMatch[0]);
      cursor = wordRe.lastIndex;
      continue;
    }
    wsRe.lastIndex = cursor;
    const wsMatch = wsRe.exec(line);
    if (wsMatch && wsMatch.index === cursor) {
      tokens.push(wsMatch[0]);
      cursor = wsRe.lastIndex;
      continue;
    }
    // Single non-word, non-whitespace char — keep punctuation as 1-char
    // tokens so e.g. `(foo)` vs `[foo]` highlights just the brackets.
    tokens.push(line.charAt(cursor));
    cursor += 1;
  }
  return tokens;
}

/** Returns word-level annotations for a `-` / `+` pair. Both lines are
 *  tokenized; the LCS table marks which tokens are unchanged. Tokens
 *  exclusive to `removed` are flagged `removed`; tokens exclusive to
 *  `added` are flagged `added`. */
export function diffWordTokens(removedLine: string, addedLine: string): WordDiffResult {
  const a = tokenize(removedLine);
  const b = tokenize(addedLine);
  // LCS dp table — sized (a.length+1) x (b.length+1). Small per-line
  // strings keep this cheap; the worst-case quadratic is still fine here.
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= a.length; i += 1) dp.push(new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const removed: DiffWordToken[] = [];
  const added: DiffWordToken[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      removed.push({ text: a[i], change: "same" });
      added.push({ text: b[j], change: "same" });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removed.push({ text: a[i], change: "removed" });
      i += 1;
    } else {
      added.push({ text: b[j], change: "added" });
      j += 1;
    }
  }
  while (i < a.length) {
    removed.push({ text: a[i], change: "removed" });
    i += 1;
  }
  while (j < b.length) {
    added.push({ text: b[j], change: "added" });
    j += 1;
  }
  return { removed, added };
}
