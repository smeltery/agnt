// Block-level lexer for the agnt-web markdown renderer. Splits source text
// into a sequence of typed blocks so the React renderer can dispatch on kind
// without re-scanning the input.
//
// Block kinds we recognise:
//   - fence       ```lang\n…\n```
//   - heading     #, ##, … ######
//   - listOrdered 1. item / 2. item / …
//   - listBullet  - item / * item
//   - table       | h1 | h2 |\n|---|---|\n| a | b |
//   - blockquote  > line (each `>`-prefixed line collapses into one block)
//   - horizontal  --- on its own line (or *** / ___)
//   - paragraph   anything else
//
// We deliberately do NOT recognize link references, footnotes, or HTML
// inline tags — the bridge doesn't emit those and shipping a full
// CommonMark parser would balloon the bundle.

export type MarkdownBlock =
  | { kind: "fence"; language: string | null; body: string }
  | { kind: "math"; body: string }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "listOrdered"; items: string[]; start: number }
  | { kind: "listBullet"; items: string[] }
  | { kind: "taskList"; items: TaskListItem[] }
  | { kind: "table"; header: string[]; rows: string[][]; alignments: Array<"left" | "right" | "center" | null> }
  | { kind: "blockquote"; text: string }
  | { kind: "horizontal" }
  | { kind: "paragraph"; text: string };

export interface TaskListItem {
  done: boolean;
  text: string;
}

const FENCE_OPEN = /^```(\w+)?\s*$/;
const FENCE_CLOSE = /^```\s*$/;
// Block math: `$$ ... $$` on its own line(s). Both fences must be on
// their own line — the lexer only treats $$ as block math when it
// stands alone, so an inline `$$E=mc^2$$` in a paragraph still routes
// through the inline-math path.
const MATH_FENCE = /^\$\$\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const ORDERED_ITEM = /^(\s*)(\d+)[.)]\s+(.+)$/;
const BULLET_ITEM = /^(\s*)[-*+]\s+(.+)$/;
// Task list — same lead as a bullet but immediately followed by `[ ]` or
// `[x]`/`[X]`. We capture the checkbox state and the remaining text.
const TASK_LIST_ITEM = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const BLOCKQUOTE = /^\s*>\s?(.*)$/;
// Three-or-more contiguous dashes/asterisks/underscores on a line by themselves.
// We don't allow mixing the three because mid-paragraph emphasis like
// `*** something ***` shouldn't accidentally match. Table dividers don't reach
// this line because they always contain `|` and TABLE_ROW catches them first.
const HORIZONTAL_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

export function lexMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.split("\n");
  const blocks: MarkdownBlock[] = [];
  let cursor = 0;

  while (cursor < lines.length) {
    const line = lines[cursor];

    // Fenced code blocks are sticky — anything between opening and closing
    // fence is taken verbatim, including blank lines.
    const fenceMatch = FENCE_OPEN.exec(line);
    if (fenceMatch) {
      const language = fenceMatch[1] ?? null;
      const body: string[] = [];
      cursor += 1;
      while (cursor < lines.length && !FENCE_CLOSE.test(lines[cursor])) {
        body.push(lines[cursor]);
        cursor += 1;
      }
      // Eat the closing fence if we hit one (otherwise the block runs to EOF).
      if (cursor < lines.length) cursor += 1;
      blocks.push({ kind: "fence", language, body: body.join("\n") });
      continue;
    }

    // Block math: `$$\n…\n$$`. Same sticky behavior as fences — body
    // lines are taken verbatim and the closing `$$` is consumed.
    if (MATH_FENCE.test(line)) {
      const body: string[] = [];
      cursor += 1;
      while (cursor < lines.length && !MATH_FENCE.test(lines[cursor])) {
        body.push(lines[cursor]);
        cursor += 1;
      }
      if (cursor < lines.length) cursor += 1;
      blocks.push({ kind: "math", body: body.join("\n") });
      continue;
    }

    if (!line.trim()) {
      cursor += 1;
      continue;
    }

    const headingMatch = HEADING.exec(line);
    if (headingMatch) {
      const hashes = headingMatch[1];
      const level = Math.min(6, hashes.length) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: "heading", level, text: headingMatch[2] });
      cursor += 1;
      continue;
    }

    if (ORDERED_ITEM.test(line)) {
      const start = Number(ORDERED_ITEM.exec(line)![2]);
      const items: string[] = [];
      while (cursor < lines.length && ORDERED_ITEM.test(lines[cursor])) {
        items.push(ORDERED_ITEM.exec(lines[cursor])![3]);
        cursor += 1;
      }
      blocks.push({ kind: "listOrdered", items, start });
      continue;
    }

    // Task lists are a strict subset of bullet lists ("- [ ]" / "- [x]") so
    // we test for them BEFORE BULLET_ITEM. If an item in a contiguous run
    // doesn't have a checkbox, we fall back to treating the whole run as a
    // bullet list — mixing tasks with plain bullets in one block isn't worth
    // the renderer complexity.
    if (TASK_LIST_ITEM.test(line)) {
      const items: TaskListItem[] = [];
      while (cursor < lines.length && TASK_LIST_ITEM.test(lines[cursor])) {
        const match = TASK_LIST_ITEM.exec(lines[cursor])!;
        items.push({ done: match[2].toLowerCase() === "x", text: match[3] });
        cursor += 1;
      }
      blocks.push({ kind: "taskList", items });
      continue;
    }

    if (BULLET_ITEM.test(line)) {
      const items: string[] = [];
      // Stop at a task-list line so the next iteration emits a separate
      // taskList block; otherwise a `- [ ]` would ride in as a plain bullet
      // because `[ ] beta` matches the BULLET_ITEM regex.
      while (
        cursor < lines.length
        && BULLET_ITEM.test(lines[cursor])
        && !TASK_LIST_ITEM.test(lines[cursor])
      ) {
        items.push(BULLET_ITEM.exec(lines[cursor])![2]);
        cursor += 1;
      }
      blocks.push({ kind: "listBullet", items });
      continue;
    }

    // Tables need a header row immediately followed by a divider row, then
    // zero or more body rows. If the divider doesn't show up on the next line
    // we treat it as a paragraph instead.
    if (TABLE_ROW.test(line) && cursor + 1 < lines.length && TABLE_DIVIDER.test(lines[cursor + 1])) {
      const header = splitTableRow(line);
      const alignments = parseTableAlignments(lines[cursor + 1]);
      // Pad alignments to header length so renderer can index by column safely.
      while (alignments.length < header.length) alignments.push(null);
      cursor += 2;
      const rows: string[][] = [];
      while (cursor < lines.length && TABLE_ROW.test(lines[cursor])) {
        rows.push(splitTableRow(lines[cursor]));
        cursor += 1;
      }
      blocks.push({ kind: "table", header, rows, alignments });
      continue;
    }

    // Horizontal rule must be checked before blockquote/paragraph because
    // an `*` HR could otherwise look like a malformed bullet list.
    if (HORIZONTAL_RULE.test(line)) {
      blocks.push({ kind: "horizontal" });
      cursor += 1;
      continue;
    }

    // Blockquotes collapse consecutive `>`-prefixed lines into one block.
    // We strip the leading `>` (and one optional space) from each line so
    // the renderer can run the normal paragraph inline tokenizer over the
    // result — bold/italic/links inside a quote should still work.
    if (BLOCKQUOTE.test(line)) {
      const quoteLines: string[] = [BLOCKQUOTE.exec(line)![1]];
      cursor += 1;
      while (cursor < lines.length && BLOCKQUOTE.test(lines[cursor])) {
        quoteLines.push(BLOCKQUOTE.exec(lines[cursor])![1]);
        cursor += 1;
      }
      blocks.push({ kind: "blockquote", text: quoteLines.join(" ").trim() });
      continue;
    }

    // Plain paragraph — accumulate consecutive non-empty, non-block lines.
    const paragraphLines: string[] = [line];
    cursor += 1;
    while (
      cursor < lines.length &&
      lines[cursor].trim() &&
      !FENCE_OPEN.test(lines[cursor]) &&
      !HEADING.test(lines[cursor]) &&
      !ORDERED_ITEM.test(lines[cursor]) &&
      !BULLET_ITEM.test(lines[cursor]) &&
      !TASK_LIST_ITEM.test(lines[cursor]) &&
      !HORIZONTAL_RULE.test(lines[cursor]) &&
      !BLOCKQUOTE.test(lines[cursor]) &&
      !(TABLE_ROW.test(lines[cursor]) && cursor + 1 < lines.length && TABLE_DIVIDER.test(lines[cursor + 1]))
    ) {
      paragraphLines.push(lines[cursor]);
      cursor += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function splitTableRow(line: string): string[] {
  // Trim the outer pipes (if any) before splitting so we don't get empty
  // leading/trailing cells. Each cell is whitespace-trimmed.
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseTableAlignments(line: string): Array<"left" | "right" | "center" | null> {
  const cells = splitTableRow(line);
  return cells.map((cell) => {
    const startsWithColon = cell.startsWith(":");
    const endsWithColon = cell.endsWith(":");
    if (startsWithColon && endsWithColon) return "center";
    if (endsWithColon) return "right";
    if (startsWithColon) return "left";
    return null;
  });
}
