import { useEffect, useMemo, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { ensureLanguage, escapeHtml, highlightCode, isLanguageReady, knownLanguage } from "./syntax-highlight";

interface CodeBlockProps {
  language: string | null;
  body: string;
  defaultLineNumbers?: boolean;
}

/**
 * Code renderer that lazy-loads the requested Prism language. While the grammar
 * is being fetched we render plain escaped text with the same layout.
 */
export function CodeBlock({ language, body, defaultLineNumbers = false }: CodeBlockProps) {
  const canonical = knownLanguage(language ?? undefined);
  const [ready, setReady] = useState(canonical ? isLanguageReady(canonical) : false);
  const [justCopied, setJustCopied] = useState(false);
  const [showLineNumbers, setShowLineNumbers] = useState(defaultLineNumbers);

  const lineCount = useMemo(() => {
    if (!body) return 0;
    const lines = body.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.length;
  }, [body]);

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
    <pre
      className={
        "agnt-md-pre"
        + (canonical ? " agnt-md-lang-" + canonical : "")
        + (showLineNumbers ? " agnt-md-pre-numbered" : "")
      }
    >
      {showLineNumbers && lineCount > 0 && (
        <span className="agnt-md-pre-gutter" aria-hidden>
          {Array.from({ length: lineCount }, (_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </span>
      )}
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
      {canonical && (
        <span className="agnt-md-pre-lang" aria-hidden>
          {canonical}
        </span>
      )}
      {lineCount > 1 && (
        <button
          type="button"
          className={"agnt-md-pre-lines" + (showLineNumbers ? " agnt-md-pre-lines-on" : "")}
          onClick={() => setShowLineNumbers((open) => !open)}
          aria-pressed={showLineNumbers}
          title={showLineNumbers ? "Hide line numbers" : "Show line numbers"}
        >
          #
        </button>
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
