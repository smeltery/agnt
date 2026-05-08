// Renders a unified-diff fragment with per-line coloring and per-hunk
// collapse toggles. Each `@@ … @@` hunk owns a clickable header that hides
// its body without affecting sibling hunks; meta lines (file headers) are
// always rendered so the user knows which file they're looking at even when
// every hunk is collapsed.

import { useState } from "react";
import { groupDiffByHunks } from "../../lib/diff-hunk-grouper";

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
            {!collapsed && hunk.body.map((line, lineIndex) => (
              <span key={`hunk-${hunk.index}-line-${lineIndex}`} className={classifyLine(line)}>
                {line}
                {lineIndex < hunk.body.length - 1 ? "\n" : ""}
              </span>
            ))}
          </span>
        );
      })}
    </pre>
  );
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
