// Tiny markdown renderer focused on the slice the bridge actually emits:
// fenced code blocks, inline code, bold/italic, and newlines. We deliberately
// avoid a full markdown library this session to keep the bundle small;
// real syntax highlighting + tables/lists land in a later session.
//
// Code blocks render as <pre><code> with the language as a CSS class so a
// follow-up session can wire shiki/highlight.js without touching this file.

import { Fragment, type ReactNode } from "react";
import { highlightCode, resolveLanguage } from "./syntax-highlight";

const FENCE_PATTERN = /```(\w+)?\n([\s\S]*?)```/g;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const BOLD_PATTERN = /\*\*([^*\n]+)\*\*/g;
const ITALIC_PATTERN = /(?<!\w)\*([^*\n]+)\*(?!\w)/g;

export function MarkdownContent({ text }: { text: string }) {
  if (!text) return null;
  return <>{renderFenced(text)}</>;
}

function renderFenced(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(FENCE_PATTERN)) {
    const [full, language, body] = match;
    const start = match.index ?? 0;
    if (start > lastIndex) nodes.push(renderInline(text.slice(lastIndex, start), key++));
    const resolved = resolveLanguage(language);
    nodes.push(
      <pre key={key++} className={"agnt-md-pre" + (resolved ? " agnt-md-lang-" + resolved : "")}>
        {resolved ? (
          <code
            className={"language-" + resolved}
            // Prism produces sanitized HTML (escapes &, <, >); safe to inject.
            dangerouslySetInnerHTML={{ __html: highlightCode(body, resolved) }}
          />
        ) : (
          <code>{body}</code>
        )}
      </pre>
    );
    lastIndex = start + full.length;
  }
  if (lastIndex < text.length) nodes.push(renderInline(text.slice(lastIndex), key++));
  return nodes;
}

function renderInline(text: string, key: number): ReactNode {
  return (
    <p key={key} className="agnt-md-paragraph">
      {tokenizeInline(text).map((token, index) =>
        token.kind === "text" ? (
          <Fragment key={index}>{token.value}</Fragment>
        ) : token.kind === "code" ? (
          <code key={index} className="agnt-md-code">
            {token.value}
          </code>
        ) : token.kind === "bold" ? (
          <strong key={index}>{token.value}</strong>
        ) : (
          <em key={index}>{token.value}</em>
        )
      )}
    </p>
  );
}

type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "bold"; value: string }
  | { kind: "italic"; value: string };

function tokenizeInline(text: string): InlineToken[] {
  // Greedy left-to-right pass: prefer code → bold → italic. Anything else is text.
  // Keeps the parser obvious; the bridge doesn't send nested markup we need to
  // worry about for this session's scope.
  const matchers: Array<{ kind: InlineToken["kind"]; pattern: RegExp }> = [
    { kind: "code", pattern: INLINE_CODE_PATTERN },
    { kind: "bold", pattern: BOLD_PATTERN },
    { kind: "italic", pattern: ITALIC_PATTERN },
  ];
  type Hit = { kind: InlineToken["kind"]; start: number; end: number; value: string };
  const hits: Hit[] = [];
  for (const { kind, pattern } of matchers) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      hits.push({ kind, start: match.index, end: match.index + match[0].length, value: match[1] });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue; // overlapping match — skip
    if (hit.start > cursor) tokens.push({ kind: "text", value: text.slice(cursor, hit.start) });
    tokens.push({ kind: hit.kind, value: hit.value });
    cursor = hit.end;
  }
  if (cursor < text.length) tokens.push({ kind: "text", value: text.slice(cursor) });
  return tokens;
}
