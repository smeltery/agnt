// Pure unified-diff splitter. The bridge returns the whole working-tree patch
// as one string; the panel wants per-file slices so it can render each file
// next to its row. Extracted from the component for testability.
//
// We deliberately don't try to be a full diff parser — the input is whatever
// `git diff` emits, which is already well-formed. We just slice on the
// per-file boundary `diff --git a/<path> b/<path>` and recover the path from
// the same line. New (`/dev/null` →) and deleted (→ `/dev/null`) files still
// have a stable `b/<path>` or `a/<path>` we can read.

export interface ParsedDiffFile {
  /** Path as written in the `diff --git` header (post-rename if a rename). */
  path: string;
  /** The raw per-file patch including its `diff --git` header line. */
  patch: string;
}

const FILE_HEADER_RE = /^diff --git a\/(.+?) b\/(.+?)$/m;

export function splitUnifiedDiff(unified: string): ParsedDiffFile[] {
  if (!unified || !unified.trim()) return [];
  const out: ParsedDiffFile[] = [];
  // Split keeps the `diff --git` boundary in front of each chunk.
  const chunks = unified.split(/(?=^diff --git )/m);
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const match = FILE_HEADER_RE.exec(chunk);
    if (!match) continue;
    // Prefer the b/ side because that's the post-state path, which matches
    // what `git status --porcelain` lists for renames.
    const path = match[2] || match[1];
    out.push({ path, patch: chunk.replace(/\n+$/, "") + "\n" });
  }
  return out;
}

/** Look up a single file's patch by path. Returns undefined when the unified
 *  diff doesn't mention that file (e.g. a non-tracked status row). */
export function findFileDiff(unified: string, path: string): string | undefined {
  return splitUnifiedDiff(unified).find((entry) => entry.path === path)?.patch;
}
