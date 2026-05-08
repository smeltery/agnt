// Renders a unified-diff fragment with per-line coloring, per-hunk
// collapse, and word-level intra-line highlighting. Each `@@ … @@` hunk
// owns a clickable header that hides its body without affecting sibling
// hunks; meta lines (file headers) are always rendered so the user knows
// which file they're looking at even when every hunk is collapsed. Pairs
// of adjacent `-` / `+` lines are scanned for word-level differences so a
// one-character rename inside a long line shows up tightly.

import { useMemo, useState } from "react";
import { groupDiffByHunks } from "../../lib/diff-hunk-grouper";
import { diffWordTokens, type DiffWordToken } from "../../lib/diff-word-tokens";

interface DiffViewProps {
  patch: string;
}

export function DiffView({ patch }: DiffViewProps) {
  const groups = groupDiffByHunks(patch);
  const [collapsedHunks, setCollapsedHunks] = useState<Set<number>>(() => new Set());

  function toggleHunk(index: number) {
    setCollapsedHunks((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return (
    <pre className="agnt-diff-view">
      {groups.meta.map((line, index) => (
        <span key={`meta-${index}`} className={classifyLine(line)}>
          {line}
          {"\n"}
        </span>
      ))}
      {groups.hunks.map((hunk) => {
        const collapsed = collapsedHunks.has(hunk.index);
        const insertions = hunk.body.filter((line) => line.startsWith("+") && !line.startsWith("+++ ")).length;
        const deletions = hunk.body.filter((line) => line.startsWith("-") && !line.startsWith("--- ")).length;
        return (
          <span key={`hunk-${hunk.index}`}>
            <span
              className={"agnt-diff-hunk agnt-diff-hunk-toggle" + (collapsed ? " agnt-diff-hunk-collapsed" : "")}
              role="button"
              tabIndex={0}
              onClick={() => toggleHunk(hunk.index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  toggleHunk(hunk.index);
                }
              }}
              aria-expanded={!collapsed}
              title={collapsed ? "Expand this hunk" : "Collapse this hunk"}
            >
              <span className="agnt-diff-hunk-chevron" aria-hidden>{collapsed ? "▸" : "▾"}</span>
              {hunk.header}
              {collapsed && (insertions > 0 || deletions > 0) && (
                <span className="agnt-diff-hunk-summary">
                  {" · "}
                  <span className="agnt-gitpanel-stat-add">+{insertions}</span>
                  {" "}
                  <span className="agnt-gitpanel-stat-del">−{deletions}</span>
                </span>
              )}
              {"\n"}
            </span>
            {!collapsed && <HunkBody hunkIndex={hunk.index} body={hunk.body} />}
          </span>
        );
      })}
    </pre>
  );
}

function HunkBody({ hunkIndex, body }: { hunkIndex: number; body: string[] }) {
  // Compute word-level annotations for adjacent `-` / `+` line pairs once
  // per body — keyed by the absolute position so React keys stay stable.
  // We only diff one-to-one runs because aligning a 3-removal-2-addition
  // hunk would need a full Myers' or histogram diff; in practice most
  // hunks are 1:1 swaps and we get the lion's share of the value.
  const annotations = useMemo(() => computeWordAnnotations(body), [body]);
  return (
    <>
      {body.map((line, lineIndex) => {
        const isLast = lineIndex === body.length - 1;
        const klass = classifyLine(line);
        const wordTokens = annotations[lineIndex];
        if (wordTokens) {
          return (
            <span key={`hunk-${hunkIndex}-line-${lineIndex}`} className={klass}>
              {wordTokens.map((token, tokenIndex) => (
                <span
                  key={tokenIndex}
                  className={token.change === "same" ? "agnt-diff-word-same" : `agnt-diff-word-${token.change}`}
                >
                  {token.text}
                </span>
              ))}
              {isLast ? "" : "\n"}
            </span>
          );
        }
        return (
          <span key={`hunk-${hunkIndex}-line-${lineIndex}`} className={klass}>
            {line}
            {isLast ? "" : "\n"}
          </span>
        );
      })}
    </>
  );
}

/** Walks the hunk body looking for one-to-one `-` then `+` pairs. Returns a
 *  map from line index to the per-token annotation, or undefined for lines
 *  that don't get word-level highlighting (context, file-header pairs, or
 *  unbalanced multi-line edits). */
function computeWordAnnotations(body: string[]): Array<DiffWordToken[] | undefined> {
  const out: Array<DiffWordToken[] | undefined> = new Array(body.length).fill(undefined);
  for (let i = 0; i < body.length - 1; i += 1) {
    const left = body[i];
    const right = body[i + 1];
    // Skip the file-header `--- a/...` / `+++ b/...` lines that occasionally
    // re-appear in a hunk body (rename + edit), and any unbalanced runs.
    if (!isRemoveDataLine(left) || !isAddDataLine(right)) continue;
    if (i + 2 < body.length && (isRemoveDataLine(body[i + 2]) || isAddDataLine(body[i + 2]))) continue;
    const { removed, added } = diffWordTokens(left.slice(1), right.slice(1));
    // Re-prepend the leading `-` / `+` as `same` tokens so the marker is
    // never highlighted as a removed/added word in itself.
    out[i] = [{ text: "-", change: "same" }, ...removed];
    out[i + 1] = [{ text: "+", change: "same" }, ...added];
    i += 1;
  }
  return out;
}

function isRemoveDataLine(line: string): boolean {
  return line.startsWith("-") && !line.startsWith("--- ");
}
function isAddDataLine(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++ ");
}

function classifyLine(line: string): string {
  // Order matters: `+++ ` and `--- ` (with trailing space) are file-header
  // markers, not add/remove lines. Hunk markers (`@@ `) win over the leading-
  // space body lines.
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "agnt-diff-meta";
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return "agnt-diff-meta";
  if (line.startsWith("@@ ")) return "agnt-diff-hunk";
  if (line.startsWith("+")) return "agnt-diff-add";
  if (line.startsWith("-")) return "agnt-diff-remove";
  return "agnt-diff-context";
}
