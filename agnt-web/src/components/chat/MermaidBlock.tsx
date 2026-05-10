// Mermaid diagram renderer. Lazy-loads the mermaid library on first use
// (~150 KB gzip; Vite chunks it on its own so users who never paste a
// mermaid fence pay nothing). Renders the SVG into an inner div via
// `mermaid.render`, which gives us a static SVG string we can drop in
// without leaving live JS in the page.
//
// Errors land as a small red panel below the source so users see what
// went wrong instead of a silent gap. The fallback also keeps the
// original source visible so they can copy/paste it elsewhere.

import { useEffect, useRef, useState } from "react";

let initialized = false;
let mermaidInstance: typeof import("mermaid").default | null = null;

async function ensureMermaid(): Promise<typeof import("mermaid").default> {
  if (mermaidInstance) return mermaidInstance;
  // Vite chunks dynamic imports; mermaid lands in its own asset.
  const mod = await import("mermaid");
  if (!initialized) {
    // `securityLevel: "strict"` keeps mermaid from injecting raw HTML
    // from the diagram source — important since the source is
    // assistant-authored and we don't trust it implicitly.
    // `theme: "default"` doesn't hardcode light/dark; the mermaid CSS
    // honors `currentColor` for most strokes so it adapts to our palette.
    mod.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral",
      fontFamily: "var(--agnt-mono, monospace)",
    });
    initialized = true;
  }
  mermaidInstance = mod.default;
  return mermaidInstance;
}

let nextId = 0;

export function MermaidBlock({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Each render needs a unique id; mermaid uses it as the id of the
  // generated <svg> root and as a temporary mount point for layout.
  const idRef = useRef<string>(`agnt-mmd-${nextId++}`);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSvg(null);
    void (async () => {
      try {
        const mermaid = await ensureMermaid();
        // `parse` validates the syntax up-front so a malformed diagram
        // surfaces as a friendly error rather than mermaid's stack trace.
        await mermaid.parse(source);
        const result = await mermaid.render(idRef.current, source);
        if (!cancelled) setSvg(result.svg);
      } catch (err) {
        if (!cancelled) {
          // mermaid throws plain `Error` with a multi-line message.
          // Keep just the first line so the panel stays compact.
          const message = (err as Error)?.message?.split("\n")[0] ?? "Failed to render diagram";
          setError(message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (error) {
    return (
      <div className="agnt-md-mermaid agnt-md-mermaid-error" role="alert">
        <div className="agnt-md-mermaid-error-message">Mermaid: {error}</div>
        <pre className="agnt-md-mermaid-source">{source}</pre>
      </div>
    );
  }
  if (!svg) {
    // Skeleton during the first paint — keeps the row height stable so
    // a long diagram doesn't pop the chat scroll position when it lands.
    return <div className="agnt-md-mermaid agnt-md-mermaid-pending" aria-busy />;
  }
  return (
    <div
      className="agnt-md-mermaid"
      // The SVG comes from mermaid's strict-mode renderer; we don't
      // pass it through a sanitizer beyond that. If we ever loosen
      // securityLevel above, this needs to flip to a real sanitizer.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
