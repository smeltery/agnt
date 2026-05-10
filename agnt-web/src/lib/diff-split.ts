// Split a unified diff into a side-by-side row sequence. Each row is a
// pair (left, right) of line tokens — context lines repeat on both
// sides; deletions appear left-only; additions right-only; the splitter
// pads the shorter side with empty rows so the columns stay aligned.
//
// Scope: just the body of one file's diff (what FileChangeRow renders).
// We don't try to parse the `diff --git` / `index ` / `+++ ` / `---`
// header lines — they're decorative metadata, not content the user
// wants in a column view.

export type DiffLineKind = "context" | "add" | "remove" | "hunk" | "blank";

export interface DiffLine {
  kind: DiffLineKind;
  /** Original 1-based line number on the left (old) file, when known. */
  leftNumber?: number;
  /** Original 1-based line number on the right (new) file, when known. */
  rightNumber?: number;
  /** Line text without the leading +/-/space marker. */
  text: string;
}

export interface SplitRow {
  /** Left-side line; `null` when this row is an addition (right-only). */
  left: DiffLine | null;
  /** Right-side line; `null` when this row is a deletion (left-only). */
  right: DiffLine | null;
}

const HUNK_RE = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

/** Parse a unified diff body into a flat sequence of typed lines. We
 *  keep this exposed (not just the split form) because the unified view
 *  also benefits from typed metadata (line numbers in the gutter, etc.). */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  if (!diff) return [];
  const out: DiffLine[] = [];
  let leftCursor = 0;
  let rightCursor = 0;
  const lines = diff.split("\n");
  // Drop a single trailing empty produced by a body that ends with `\n`.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = HUNK_RE.exec(line);
      if (match) {
        leftCursor = Number(match[1]);
        rightCursor = Number(match[2]);
      }
      out.push({ kind: "hunk", text: line });
      continue;
    }
    // Skip the metadata header lines that aren't content. We don't want
    // them in a side-by-side view; the unified renderer can opt them in
    // separately if needed.
    if (
      line.startsWith("diff --git ")
      || line.startsWith("index ")
      || line.startsWith("--- ")
      || line.startsWith("+++ ")
      || line.startsWith("new file mode")
      || line.startsWith("deleted file mode")
      || line === "\\ No newline at end of file"
    ) {
      continue;
    }
    if (line.startsWith("+")) {
      out.push({ kind: "add", rightNumber: rightCursor, text: line.slice(1) });
      rightCursor += 1;
      continue;
    }
    if (line.startsWith("-")) {
      out.push({ kind: "remove", leftNumber: leftCursor, text: line.slice(1) });
      leftCursor += 1;
      continue;
    }
    // Context lines start with a space (or, for some tools, no leading
    // marker on a blank context line — handle both).
    const isContext = line.startsWith(" ") || line.length === 0;
    if (isContext) {
      out.push({
        kind: "context",
        leftNumber: leftCursor,
        rightNumber: rightCursor,
        text: line.startsWith(" ") ? line.slice(1) : line,
      });
      leftCursor += 1;
      rightCursor += 1;
    }
    // Anything else (a stray malformed line) is dropped silently — it
    // would render confusingly in either view.
  }
  return out;
}

/** Re-flow a parsed diff into side-by-side rows. Adjacent remove/add
 *  pairs zip together (left=remove, right=add) — the common "edit"
 *  shape. Unmatched removes/adds get a blank pad on the opposite side. */
export function splitUnifiedDiff(diff: string): SplitRow[] {
  const lines = parseUnifiedDiff(diff);
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "context" || line.kind === "hunk") {
      rows.push({ left: line, right: line });
      i += 1;
      continue;
    }
    if (line.kind === "remove") {
      // Collect the run of removes followed by the run of adds, then
      // zip them. This produces sensible 1:1 pairing for the common
      // edit shape (n removes followed by m adds at the same hunk).
      const removes: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === "remove") {
        removes.push(lines[i]);
        i += 1;
      }
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === "add") {
        adds.push(lines[i]);
        i += 1;
      }
      const pairs = Math.max(removes.length, adds.length);
      for (let j = 0; j < pairs; j += 1) {
        rows.push({
          left: removes[j] ?? { kind: "blank", text: "" },
          right: adds[j] ?? { kind: "blank", text: "" },
        });
      }
      continue;
    }
    if (line.kind === "add") {
      // A bare add (no preceding removes) — left side is blank.
      rows.push({ left: { kind: "blank", text: "" }, right: line });
      i += 1;
      continue;
    }
    i += 1;
  }
  return rows;
}
