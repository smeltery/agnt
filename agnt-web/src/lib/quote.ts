// Format a string as a Markdown blockquote — used by the per-row Reply
// button. We strip code fences so a quoted assistant answer doesn't
// accidentally re-open a fenced block in the user's draft, then prefix
// each line with `> `. Long quotes get truncated to a reasonable cap so
// the composer doesn't immediately get flooded by a 5,000-line answer.

const MAX_QUOTE_CHARS = 1500;

export function quoteAsMarkdown(text: string): string {
  if (!text || !text.trim()) return "";
  // Drop fenced-code markers so a quoted code block renders as monospaced
  // body text rather than reopening a fence. We don't try to preserve
  // inner formatting — the user can scroll back to the original row.
  const stripped = text.replace(/^```[a-zA-Z0-9_+\-]*\s*\n?/gm, "").replace(/^```\s*$/gm, "");
  const truncated = stripped.length > MAX_QUOTE_CHARS
    ? stripped.slice(0, MAX_QUOTE_CHARS).trimEnd() + " …"
    : stripped;
  return truncated
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}
