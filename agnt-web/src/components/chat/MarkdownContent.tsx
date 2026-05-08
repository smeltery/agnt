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
import { useConnectionStore } from "../../state/connection-store";
import { selectImageState, useWorkspaceImageCache } from "../../state/workspace-image-cache";
import { lexMarkdownBlocks, type MarkdownBlock } from "./markdown-blocks";
import { ensureLanguage, escapeHtml, highlightCode, isLanguageReady, knownLanguage } from "./syntax-highlight";

const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const BOLD_PATTERN = /\*\*([^*\n]+)\*\*/g;
const ITALIC_PATTERN = /(?<!\w)\*([^*\n]+)\*(?!\w)/g;
const IMAGE_PATTERN = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"([^"\n]*)")?\)/g;
const LINK_PATTERN = /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"([^"\n]*)")?\)/g;
// Bare-URL autolinks. Recognises http(s) URLs not already inside a `[](…)`
// or `![](…)` construct (the explicit-link patterns above run first and
// consume those positions via the dedup step in the cursor walk). Trailing
// punctuation (.,;:!?]) ) is excluded from the match so a sentence like
// "Visit https://example.com." doesn't link the period. We deliberately
// don't add `(` to the negative lookbehind because URLs frequently appear
// in parentheses ("see (https://example.com)") and the dedup against
// LINK_PATTERN already prevents double-wrapping inside `[](…)`.
const AUTOLINK_PATTERN = /(?<![\w@:/])\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?\]\)]/g;

export interface MarkdownContentProps {
  text: string;
  /** Thread cwd — when set, non-http image refs route through `workspace/readImage`. */
  cwd?: string;
}

export function MarkdownContent({ text, cwd }: MarkdownContentProps) {
  if (!text) return null;
  const blocks = lexMarkdownBlocks(text);
  return (
    <>
      {blocks.map((block, index) => (
        <Fragment key={index}>{renderBlock(block, cwd)}</Fragment>
      ))}
    </>
  );
}

function renderBlock(block: MarkdownBlock, cwd: string | undefined): ReactNode {
  switch (block.kind) {
    case "fence":
      return renderFence(block.language, block.body);
    case "heading":
      return renderHeading(block.level, block.text, cwd);
    case "listOrdered":
      return (
        <ol className="agnt-md-list" start={block.start}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInlineFragments(item, cwd)}</li>
          ))}
        </ol>
      );
    case "listBullet":
      return (
        <ul className="agnt-md-list">
          {block.items.map((item, index) => (
            <li key={index}>{renderInlineFragments(item, cwd)}</li>
          ))}
        </ul>
      );
    case "taskList":
      return (
        <ul className="agnt-md-list agnt-md-tasklist">
          {block.items.map((item, index) => (
            <li
              key={index}
              className={"agnt-md-tasklist-item" + (item.done ? " agnt-md-tasklist-done" : "")}
            >
              <input
                type="checkbox"
                checked={item.done}
                disabled
                aria-label={item.done ? "Completed" : "Not completed"}
                className="agnt-md-tasklist-checkbox"
              />
              <span>{renderInlineFragments(item.text, cwd)}</span>
            </li>
          ))}
        </ul>
      );
    case "table":
      return renderTable(block, cwd);
    case "blockquote":
      return <blockquote className="agnt-md-blockquote">{renderInlineFragments(block.text, cwd)}</blockquote>;
    case "horizontal":
      return <hr className="agnt-md-hr" />;
    case "paragraph":
      return <p className="agnt-md-paragraph">{renderInlineFragments(block.text, cwd)}</p>;
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

function renderHeading(level: 1 | 2 | 3 | 4 | 5 | 6, text: string, cwd: string | undefined): ReactNode {
  const className = "agnt-md-heading agnt-md-h" + level;
  const children = renderInlineFragments(text, cwd);
  switch (level) {
    case 1: return <h1 className={className}>{children}</h1>;
    case 2: return <h2 className={className}>{children}</h2>;
    case 3: return <h3 className={className}>{children}</h3>;
    case 4: return <h4 className={className}>{children}</h4>;
    case 5: return <h5 className={className}>{children}</h5>;
    case 6: return <h6 className={className}>{children}</h6>;
  }
}

function renderTable(block: Extract<MarkdownBlock, { kind: "table" }>, cwd: string | undefined): ReactNode {
  return (
    <div className="agnt-md-table-wrapper">
      <table className="agnt-md-table">
        <thead>
          <tr>
            {block.header.map((cell, index) => (
              <th key={index} style={alignStyle(block.alignments[index])}>
                {renderInlineFragments(cell, cwd)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, columnIndex) => (
                <td key={columnIndex} style={alignStyle(block.alignments[columnIndex])}>
                  {renderInlineFragments(cell, cwd)}
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

function renderInlineFragments(text: string, cwd: string | undefined): ReactNode {
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
        // Direct http/data sources go straight to <img>; non-web paths route
        // through workspace/readImage if we have a cwd to resolve against.
        if (token.url.startsWith("http") || token.url.startsWith("data:")) {
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
        return (
          <WorkspaceImage
            key={index}
            cwd={cwd}
            path={token.url}
            label={token.label}
            title={token.title}
          />
        );
    }
  });
}

interface WorkspaceImageProps {
  cwd: string | undefined;
  path: string;
  label: string;
  title?: string;
}

function WorkspaceImage({ cwd, path, label, title }: WorkspaceImageProps) {
  const connection = useConnectionStore((state) => state.connection);
  // Zustand re-renders this component when the selector's result reference
  // changes; we don't need a forceUpdate here.
  const cached = useWorkspaceImageCache(selectImageState(cwd ?? "", path));
  const ensure = useWorkspaceImageCache((state) => state.ensure);

  useEffect(() => {
    if (!cwd || !connection?.rpc) return;
    void ensure(connection.rpc, { cwd, path });
  }, [cwd, path, connection, ensure]);

  if (!cwd) {
    return (
      <span className="agnt-md-image-placeholder" title={`No workspace cwd; can't fetch ${path}`}>
        {label || path}
      </span>
    );
  }
  if (cached && typeof cached === "object" && "error" in cached) {
    return (
      <span className="agnt-md-image-placeholder agnt-md-image-error" title={cached.error}>
        ⚠ {label || path}
      </span>
    );
  }
  if (cached && typeof cached === "object" && "dataUrl" in cached) {
    return (
      <img
        src={cached.dataUrl}
        alt={label || title || path}
        title={title ?? path}
        className="agnt-md-image"
      />
    );
  }
  // loading | null
  return (
    <span className="agnt-md-image-placeholder" title={path}>
      Loading {label || path}…
    </span>
  );
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
// Plain paths with no scheme (`screenshot.png`, `.tmp/cap.png`) are accepted
// and resolved against a thread cwd via workspace/readImage. The render layer
// double-checks before fetching.
const HAS_URL_SCHEME = /^[a-z][a-z0-9+\-.]*:/i;

function tokenizeInline(text: string): InlineToken[] {
  const hits: InlineHit[] = [];
  // Image first so its leading `!` consumes the position before the link
  // matcher can — we can't rely on regex alternation since each pattern is
  // matched independently then deduped by start.
  IMAGE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(IMAGE_PATTERN)) {
    if (match.index === undefined) continue;
    const url = match[2];
    // Either the URL has a safe image scheme, or it has no scheme at all
    // (= relative/absolute filesystem path → workspace fetch).
    if (HAS_URL_SCHEME.test(url) && !SAFE_IMAGE_SCHEMES.test(url)) continue;
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
  AUTOLINK_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(AUTOLINK_PATTERN)) {
    if (match.index === undefined) continue;
    hits.push({
      kind: "link",
      start: match.index,
      end: match.index + match[0].length,
      label: match[0],
      url: match[0],
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
