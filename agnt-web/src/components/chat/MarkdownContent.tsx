// Block-level dispatcher. Lexer in markdown-blocks.ts returns a typed
// sequence; we render each block with a small dedicated component. Inline
// tokenization (bold/italic/code) is shared across paragraph, heading,
// list-item, and table-cell content via `renderInlineFragments`.
//
// Bridge agents emit fenced code, inline code, bold/italic, lists, headings,
// and tables. We deliberately do not handle blockquotes, link references,
// nested lists, or HTML inline tags — bundle stays small and the output
// stays predictable.

import { Fragment, lazy, Suspense, type ReactNode, useEffect, useState } from "react";
import { useConnectionStore } from "../../state/connection-store";
import { useLightboxStore } from "../../state/lightbox-store";
import { selectImageState, useWorkspaceImageCache } from "../../state/workspace-image-cache";
import { decodeSvgDataUrl, isSvgDataUrl, isSvgPath } from "../../lib/workspace-svg-preview";
import { isLocalWorkspaceLink } from "../../lib/workspace-text-preview";
import { CodeBlock } from "./CodeBlock";
import { WorkspaceSvgPreview } from "./WorkspaceSvgPreview";
import { WorkspaceTextFilePreview } from "./WorkspaceTextFilePreview";
import { tokenizeInline } from "./markdown-inline-tokens";

// Mermaid lives in its own chunk via React.lazy so the mermaid library
// (~150 KB gzip) only downloads when a diagram actually appears.
const MermaidBlock = lazy(() =>
  import("./MermaidBlock").then((m) => ({ default: m.MermaidBlock }))
);

// KaTeX (and its CSS) lazy-load on first math block / inline use; same
// pattern as Mermaid. Inline math goes through the same component with
// `displayMode={false}` so we only need one lazy boundary.
const MathBlock = lazy(() =>
  import("./MathBlock").then((m) => ({ default: m.MathBlock }))
);
import { lexMarkdownBlocks, type MarkdownBlock } from "./markdown-blocks";

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
    case "math":
      return (
        <Suspense fallback={<div className="agnt-md-math agnt-md-math-pending" aria-busy />}>
          <MathBlock body={block.body} displayMode />
        </Suspense>
      );
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
  // ```mermaid fences render as a diagram. The MermaidBlock module
  // lazy-loads the mermaid library on first use so the cost only lands
  // when a diagram actually appears in chat.
  if (language && language.toLowerCase() === "mermaid") {
    return (
      <Suspense fallback={<div className="agnt-md-mermaid agnt-md-mermaid-pending" aria-busy />}>
        <MermaidBlock source={body} />
      </Suspense>
    );
  }
  return <CodeBlock language={language} body={body} />;
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
      case "math":
        return (
          <Suspense
            key={index}
            fallback={<span className="agnt-md-math-inline-pending" aria-busy />}
          >
            <MathBlock body={token.value} displayMode={token.displayMode} />
          </Suspense>
        );
      case "link":
        if (isLocalWorkspaceLink(token.url)) {
          return (
            <WorkspaceTextFileLink
              key={index}
              cwd={cwd}
              path={token.url}
              label={token.label}
              title={token.title}
            />
          );
        }
        return (
          <a key={index} href={token.url} target="_blank" rel="noreferrer noopener" title={token.title}>
            {token.label}
          </a>
        );
      case "image":
        // Direct http/data sources go straight to <img>; non-web paths route
        // through workspace/readImage if we have a cwd to resolve against.
        if (isSvgDataUrl(token.url)) {
          const svgSource = decodeSvgDataUrl(token.url);
          if (svgSource) {
            return (
              <WorkspaceSvgPreview
                key={index}
                source={svgSource}
                alt={token.label || token.title || "SVG image"}
                title={token.title ?? token.label}
              />
            );
          }
        }
        if (token.url.startsWith("http") || token.url.startsWith("data:")) {
          return (
            <img
              key={index}
              src={token.url}
              alt={token.label || token.title || "image"}
              title={token.title ?? "Click to enlarge"}
              className="agnt-md-image agnt-md-image-clickable"
              onClick={() => useLightboxStore.getState().showOne({
                src: token.url,
                alt: token.label || token.title || "image",
                caption: token.label || token.title,
              })}
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

interface WorkspaceTextFileLinkProps {
  cwd: string | undefined;
  path: string;
  label: string;
  title?: string;
}

function WorkspaceTextFileLink({ cwd, path, label, title }: WorkspaceTextFileLinkProps) {
  const [open, setOpen] = useState(false);
  const text = label || path;

  if (!cwd) {
    return (
      <span className="agnt-md-file-link-disabled" title={`No workspace cwd; can't fetch ${path}`}>
        {text}
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className="agnt-md-file-link"
        title={title ?? path}
        onClick={() => setOpen(true)}
      >
        {text}
      </button>
      {open && (
        <WorkspaceTextFilePreview
          cwd={cwd}
          path={path}
          label={text}
          open={open}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
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
    const svgSource = isSvgPath(path) || isSvgDataUrl(cached.dataUrl) ? decodeSvgDataUrl(cached.dataUrl) : null;
    if (svgSource) {
      return (
        <WorkspaceSvgPreview
          source={svgSource}
          alt={label || title || path}
          title={title ?? path}
        />
      );
    }
    return (
      <img
        src={cached.dataUrl}
        alt={label || title || path}
        title={title ?? `${path} — click to enlarge`}
        className="agnt-md-image agnt-md-image-clickable"
        onClick={() => useLightboxStore.getState().showOne({
          src: cached.dataUrl,
          alt: label || title || path,
          caption: label || path,
        })}
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
