// Groups a unified-diff string into a leading "meta" block (`diff --git`,
// `index`, `+++ a/`, `--- b/`) followed by zero or more hunks. Each hunk
// owns its `@@ … @@` header line plus the body lines that follow until the
// next hunk header or the end of the patch.
//
// Pure — DiffView consumes the result so each hunk can render its own
// click-to-collapse header without re-walking the full string.

export interface DiffHunk {
  /** Zero-based index in the parent patch — useful as a stable React key. */
  index: number;
  /** The full `@@ -A,B +C,D @@ context` header line, verbatim. */
  header: string;
  /** Body lines (no trailing newline split out) — context, additions,
   *  deletions, in source order. Includes any text after the closing `@@`
   *  on the header line as part of `header`, not body. */
  body: string[];
}

export interface DiffGroups {
  /** Lines that come before the first `@@` hunk — file headers + metadata.
   *  Always rendered (never collapsed) so the file path stays visible. */
  meta: string[];
  hunks: DiffHunk[];
}

export function groupDiffByHunks(patch: string): DiffGroups {
  const meta: string[] = [];
  const hunks: DiffHunk[] = [];
  if (!patch) return { meta, hunks };
  const lines = patch.split("\n");
  let currentHunk: DiffHunk | null = null;
  for (const line of lines) {
    if (isHunkHeader(line)) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = { index: hunks.length, header: line, body: [] };
      continue;
    }
    if (currentHunk) {
      currentHunk.body.push(line);
    } else {
      meta.push(line);
    }
  }
  if (currentHunk) hunks.push(currentHunk);
  return { meta, hunks };
}

/** Hunk headers always have a space after the trailing `@@` (`@@ -X,Y +A,B @@ context`).
 *  Requiring the trailing space avoids a misclassification for content lines
 *  that happen to start with `@@` (rare but possible). */
function isHunkHeader(line: string): boolean {
  return line.startsWith("@@ ");
}
