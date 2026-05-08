// Block-level dispatcher. Lexer in markdown-blocks.ts returns a typed
// sequence; we render each block with a small dedicated component. Inline
// tokenization (bold/italic/code) is shared across paragraph, heading,
// list-item, and table-cell content via `renderInlineFragments`.
//
// Bridge agents emit fenced code, inline code, bold/italic, lists, headings,
// and tables. We deliberately do not handle blockquotes, link references,
// nested lists, or HTML inline tags — bundle stays small and the output
// stays predictable.

import { Fragment, type ReactNode, useEffect, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { lexMarkdownBlocks, type MarkdownBlock } from "./markdown-blocks";
import { ensureLanguage, escapeHtml, highlightCode, isLanguageReady, knownLanguage } from "./syntax-highlight";

const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const BOLD_PATTERN = /\*\*([^*\n]+)\*\*/g;
const ITALIC_PATTERN = /(?<!\w)\*([^*\n]+)\*(?!\w)/g;
const IMAGE_PATTERN = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"([^"\n]*)")?\)/g;
const LINK_PATTERN = /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"([^"\n]*)")?\)/g;

export function MarkdownContent({ text }: { text: string }) {
  if (!text) return null;
  const blocks = lexMarkdownBlocks(text);
  return (
    <>
      {blocks.map((block, index) => (
        <Fragment key={index}>{renderBlock(block)}</Fragment>
      ))}
    </>
  );
}

function renderBlock(block: MarkdownBlock): ReactNode {
  switch (block.kind) {
    case "fence":
      return renderFence(block.language, block.body);
    case "heading":
      return renderHeading(block.level, block.text);
    case "listOrdered":
      return (
        <ol className="agnt-md-list" start={block.start}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInlineFragments(item)}</li>
          ))}
        </ol>
      );
    case "listBullet":
      return (
        <ul className="agnt-md-list">
          {block.items.map((item, index) => (
            <li key={index}>{renderInlineFragments(item)}</li>
          ))}
        </ul>
      );
    case "table":
      return renderTable(block);
    case "paragraph":
      return <p className="agnt-md-paragraph">{renderInlineFragments(block.text)}</p>;
  }
}

function renderFence(language: string | null, body: string): ReactNode {
  return <CodeBlock language={language} body={body} />;
}

/**
 * Code-fence renderer that lazy-loads the requested Prism language. While the
 * grammar is being fetched we render plain (HTML-escaped) text — same shape
 * as the highlighted output so the layout doesn't shift when the chunk lands.
 */
function CodeBlock({ language, body }: { language: string | null; body: string }) {
  const canonical = knownLanguage(language ?? undefined);
  const [ready, setReady] = useState(canonical ? isLanguageReady(canonical) : false);
  const [justCopied, setJustCopied] = useState(false);

  useEffect(() => {
    if (!canonical || ready) return;
    let cancelled = false;
    void ensureLanguage(canonical).then((ok) => {
      if (!cancelled && ok) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [canonical, ready]);

  async function handleCopy() {
    const ok = await copyText(body);
    if (!ok) return;
    setJustCopied(true);
    window.setTimeout(() => setJustCopied(false), 1200);
  }

  return (
    <pre className={"agnt-md-pre" + (canonical ? " agnt-md-lang-" + canonical : "")}>
      {canonical && ready ? (
        <code
          className={"language-" + canonical}
          dangerouslySetInnerHTML={{ __html: highlightCode(body, canonical) }}
        />
      ) : (
        <code
          className={canonical ? "language-" + canonical : undefined}
          dangerouslySetInnerHTML={{ __html: escapeHtml(body) }}
        />
      )}
      <button
        type="button"
        className={"agnt-md-pre-copy" + (justCopied ? " agnt-md-pre-copy-done" : "")}
        onClick={handleCopy}
        aria-label={justCopied ? "Copied" : "Copy code"}
        title={justCopied ? "Copied" : "Copy code block"}
      >
        {justCopied ? "Copied" : "Copy"}
      </button>
    </pre>
  );
}

function renderHeading(level: 1 | 2 | 3 | 4 | 5 | 6, text: string): ReactNode {
  const className = "agnt-md-heading agnt-md-h" + level;
  const children = renderInlineFragments(text);
  switch (level) {
    case 1: return <h1 className={className}>{children}</h1>;
    case 2: return <h2 className={className}>{children}</h2>;
    case 3: return <h3 className={className}>{children}</h3>;
    case 4: return <h4 className={className}>{children}</h4>;
    case 5: return <h5 className={className}>{children}</h5>;
    case 6: return <h6 className={className}>{children}</h6>;
  }
}

function renderTable(block: Extract<MarkdownBlock, { kind: "table" }>): ReactNode {
  return (
    <div className="agnt-md-table-wrapper">
      <table className="agnt-md-table">
        <thead>
          <tr>
            {block.header.map((cell, index) => (
              <th key={index} style={alignStyle(block.alignments[index])}>
                {renderInlineFragments(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, columnIndex) => (
                <td key={columnIndex} style={alignStyle(block.alignments[columnIndex])}>
                  {renderInlineFragments(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function alignStyle(align: "left" | "right" | "center" | null | undefined): React.CSSProperties | undefined {
  if (!align) return undefined;
  return { textAlign: align };
}

function renderInlineFragments(text: string): ReactNode {
  return tokenizeInline(text).map((token, index) => {
    switch (token.kind) {
      case "text":
        return <Fragment key={index}>{token.value}</Fragment>;
      case "code":
        return (
          <code key={index} className="agnt-md-code">
            {token.value}
          </code>
        );
      case "bold":
        return <strong key={index}>{token.value}</strong>;
      case "italic":
        return <em key={index}>{token.value}</em>;
      case "link":
        return (
          <a key={index} href={token.url} target="_blank" rel="noreferrer noopener" title={token.title}>
            {token.label}
          </a>
        );
      case "image":
        // alt text falls back to a non-empty placeholder so screen readers
        // don't announce a bare "image" — most agent-emitted images have a
        // descriptive alt anyway.
        return (
          <img
            key={index}
            src={token.url}
            alt={token.label || token.title || "image"}
            title={token.title}
            className="agnt-md-image"
          />
        );
    }
  });
}

type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "bold"; value: string }
  | { kind: "italic"; value: string }
  | { kind: "link"; label: string; url: string; title?: string }
  | { kind: "image"; label: string; url: string; title?: string };

interface InlineHit {
  kind: InlineToken["kind"];
  start: number;
  end: number;
  // Token-shape fields. `value` is used by the simple kinds; richer kinds
  // populate label/url/title.
  value?: string;
  label?: string;
  url?: string;
  title?: string;
}

const SAFE_LINK_SCHEMES = /^(https?:|mailto:|#)/i;
const SAFE_IMAGE_SCHEMES = /^(https?:|data:image\/)/i;

function tokenizeInline(text: string): InlineToken[] {
  const hits: InlineHit[] = [];
  // Image first so its leading `!` consumes the position before the link
  // matcher can — we can't rely on regex alternation since each pattern is
  // matched independently then deduped by start.
  IMAGE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(IMAGE_PATTERN)) {
    if (match.index === undefined) continue;
    const url = match[2];
    if (!SAFE_IMAGE_SCHEMES.test(url)) continue;
    hits.push({
      kind: "image",
      start: match.index,
      end: match.index + match[0].length,
      label: match[1],
      url,
      title: match[3],
    });
  }
  LINK_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    if (match.index === undefined) continue;
    const url = match[2];
    if (!SAFE_LINK_SCHEMES.test(url)) continue;
    hits.push({
      kind: "link",
      start: match.index,
      end: match.index + match[0].length,
      label: match[1],
      url,
      title: match[3],
    });
  }
  for (const [kind, pattern] of [
    ["code", INLINE_CODE_PATTERN] as const,
    ["bold", BOLD_PATTERN] as const,
    ["italic", ITALIC_PATTERN] as const,
  ]) {
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
    if (hit.start < cursor) continue;
    if (hit.start > cursor) tokens.push({ kind: "text", value: text.slice(cursor, hit.start) });
    if (hit.kind === "link" || hit.kind === "image") {
      tokens.push({ kind: hit.kind, label: hit.label ?? "", url: hit.url ?? "", title: hit.title });
    } else {
      tokens.push({ kind: hit.kind, value: hit.value ?? "" } as InlineToken);
    }
    cursor = hit.end;
  }
  if (cursor < text.length) tokens.push({ kind: "text", value: text.slice(cursor) });
  return tokens;
}
