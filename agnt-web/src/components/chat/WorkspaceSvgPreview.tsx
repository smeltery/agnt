import { workspaceSvgHtmlDocument } from "../../lib/workspace-svg-preview";

interface WorkspaceSvgPreviewProps {
  source: string;
  alt: string;
  title?: string;
}

export function WorkspaceSvgPreview({ source, alt, title }: WorkspaceSvgPreviewProps) {
  const isDark =
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;

  return (
    <iframe
      className="agnt-md-svg-preview"
      title={title || alt}
      aria-label={alt}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={workspaceSvgHtmlDocument(source, isDark)}
    />
  );
}
