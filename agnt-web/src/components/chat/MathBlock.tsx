// KaTeX renderer. Used for both block math (`$$ ... $$`) and inline
// math (`$ ... $`); the public API is two components that take a body
// string and a `displayMode` flag.
//
// Same lazy-load shape as MermaidBlock — the katex library lands in
// its own chunk, so users who never see math pay nothing on initial
// load. `katex.renderToString` returns sanitized HTML; we drop it in
// via dangerouslySetInnerHTML behind that boundary.
//
// We also import the katex CSS lazily via the `katex/dist/katex.min.css`
// dynamic import side effect — Vite folds it into the same chunk so the
// stylesheet only ships when math is used.

import { useEffect, useState } from "react";

let cachedRenderer: typeof import("katex").default | null = null;

async function ensureKatex(): Promise<typeof import("katex").default> {
  if (cachedRenderer) return cachedRenderer;
  // Two parallel imports: the lib + its stylesheet. Vite tracks the CSS
  // import and includes it in the chunk graph automatically.
  const [mod] = await Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css"),
  ]);
  cachedRenderer = mod.default;
  return cachedRenderer;
}

interface MathProps {
  body: string;
  /** When true, renders centered/full-width (block math). When false,
   *  renders inline so it sits in a paragraph alongside text. */
  displayMode: boolean;
}

export function MathBlock({ body, displayMode }: MathProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setHtml(null);
    void (async () => {
      try {
        const katex = await ensureKatex();
        // `throwOnError: false` keeps katex from raising on a stray
        // unbalanced brace — it'll render the source inline with a red
        // highlight, which is friendlier than a crashed component tree.
        // The macro list mirrors typical paper conventions.
        const rendered = katex.renderToString(body, {
          displayMode,
          throwOnError: false,
          // Restrict input length to defend against pathological inputs
          // from a chatty assistant — 8 KB is plenty for any realistic
          // formula.
          maxSize: 25,
          maxExpand: 1000,
          strict: "ignore",
          output: "html",
        });
        if (!cancelled) setHtml(rendered);
      } catch (err) {
        if (!cancelled) {
          const message = (err as Error)?.message?.split("\n")[0] ?? "Failed to render math";
          setError(message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [body, displayMode]);

  if (error) {
    // Fallback: surface the source so the user can copy it into a real
    // editor. The red panel is intentionally distinct from the success
    // styling so a parsing failure isn't mistaken for a rendered block.
    return displayMode ? (
      <div className="agnt-md-math agnt-md-math-error" role="alert">
        <div className="agnt-md-math-error-message">Math: {error}</div>
        <pre className="agnt-md-math-source">{body}</pre>
      </div>
    ) : (
      <code className="agnt-md-math-inline-error" title={`Math error: ${error}`}>{body}</code>
    );
  }
  if (!html) {
    // Brief skeleton — for inline math we just hold a small width
    // placeholder so paragraph wrap doesn't hop. For block math the
    // fixed min-height keeps the chat scroll position stable.
    return displayMode ? (
      <div className="agnt-md-math agnt-md-math-pending" aria-busy />
    ) : (
      <span className="agnt-md-math-inline-pending" aria-busy />
    );
  }
  return displayMode ? (
    <div className="agnt-md-math" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className="agnt-md-math-inline" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
