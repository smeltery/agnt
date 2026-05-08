// Renders a unified-diff fragment with per-line coloring. Splits on newlines
// rather than streaming via Prism — the diff is short enough per file (a
// hunks-only render is bounded by the file size in the tree) that the cost
// of per-line span elements is negligible, and we get correct copy/paste
// fidelity (Prism's diff grammar groups multi-line tokens which break copy).

interface DiffViewProps {
  patch: string;
}

export function DiffView({ patch }: DiffViewProps) {
  const lines = patch.split("\n");
  return (
    <pre className="agnt-diff-view">
      {lines.map((line, index) => {
        const klass = classifyLine(line);
        return (
          <span key={index} className={klass}>
            {line}
            {index < lines.length - 1 ? "\n" : ""}
          </span>
        );
      })}
    </pre>
  );
}

function classifyLine(line: string): string {
  // Order matters: `+++` and `---` are file-header markers, not add/remove
  // lines. Hunk markers (@@) win over the leading-space body lines.
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "agnt-diff-meta";
  if (line.startsWith("+++") || line.startsWith("---")) return "agnt-diff-meta";
  if (line.startsWith("@@")) return "agnt-diff-hunk";
  if (line.startsWith("+")) return "agnt-diff-add";
  if (line.startsWith("-")) return "agnt-diff-remove";
  return "agnt-diff-context";
}
