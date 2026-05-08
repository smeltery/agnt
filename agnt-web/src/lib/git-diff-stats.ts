// Pure +/- counter for unified-diff patches. Walks each line once and counts
// inserted (`+`) and removed (`-`) lines, ignoring the `+++`/`---` file
// headers and the `@@` hunk markers. Diff metadata lines (`diff --git`,
// `index ...`) are also skipped.
//
// Same input contract as `git-diff-parser.ts` — whatever `git diff` emits.

export interface DiffStats {
  insertions: number;
  deletions: number;
}

const ZERO: DiffStats = { insertions: 0, deletions: 0 };

export function computeDiffStats(patch: string): DiffStats {
  if (!patch) return ZERO;
  let insertions = 0;
  let deletions = 0;
  for (const rawLine of patch.split("\n")) {
    if (!rawLine) continue;
    // Match the actual file-header markers (`--- a/path`, `+++ b/path`, with
    // the mandatory trailing space) instead of any leading run of `+`/`-`.
    // Otherwise a real addition like `++++value` would be silently dropped.
    if (rawLine.startsWith("+++ ") || rawLine.startsWith("--- ")) continue;
    // Hunk markers always emit a space after the closing `@@` (`@@ -X,Y +A,B @@`).
    // Requiring the trailing space avoids a misclassification if a content line
    // ever started with `@@` directly (and lets `@@@` combined-diff hunks through
    // to be counted).
    if (rawLine.startsWith("@@ ")) continue;
    if (rawLine.startsWith("diff --git")) continue;
    if (rawLine.startsWith("index ")) continue;
    if (rawLine.startsWith("+")) insertions += 1;
    else if (rawLine.startsWith("-")) deletions += 1;
  }
  return { insertions, deletions };
}

export function sumDiffStats(stats: Iterable<DiffStats>): DiffStats {
  let insertions = 0;
  let deletions = 0;
  for (const entry of stats) {
    insertions += entry.insertions;
    deletions += entry.deletions;
  }
  return { insertions, deletions };
}

export function formatDiffStats(stats: DiffStats): string {
  return `+${stats.insertions} −${stats.deletions}`;
}
