export const WORKSPACE_SVG_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; font-src 'none'; base-uri 'none'";

const EXTERNAL_REFERENCE_PATTERN =
  /\s(?:href|xlink:href|src)\s*=\s*(?:(["'])(?:https?:|\/\/|file:)[^"']*\1|(?:https?:|\/\/|file:)[^\s>]+)/gi;

export function sanitizeWorkspaceSvgSource(source: string): string {
  return source.replace(EXTERNAL_REFERENCE_PATTERN, "");
}

export function isSvgPath(path: string): boolean {
  const trimmed = path.trim();
  const withoutHash = trimmed.split("#", 1)[0] ?? trimmed;
  const withoutQuery = withoutHash.split("?", 1)[0] ?? withoutHash;
  return withoutQuery.toLowerCase().endsWith(".svg");
}

export function isSvgDataUrl(dataUrl: string): boolean {
  return /^data:image\/svg\+xml(?:[;,]|$)/i.test(dataUrl);
}

export function decodeSvgDataUrl(dataUrl: string): string | null {
  const match = /^data:image\/svg\+xml(?:;charset=[^;,]+)?(;base64)?,(.*)$/is.exec(dataUrl);
  if (!match) return null;
  const body = match[2] ?? "";
  try {
    if (match[1]) {
      if (typeof globalThis.atob === "function") {
        return globalThis.atob(body);
      }
      return Buffer.from(body, "base64").toString("utf8");
    }
    return decodeURIComponent(body.replace(/\+/g, "%20"));
  } catch {
    return null;
  }
}

export function workspaceSvgHtmlDocument(svgSource: string, isDark: boolean): string {
  const background = isDark ? "#111114" : "#f7f7f8";
  const foreground = isDark ? "#f5f5f7" : "#111114";
  const sanitizedSvg = sanitizeWorkspaceSvgSource(svgSource);
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=8">
<meta http-equiv="Content-Security-Policy" content="${WORKSPACE_SVG_CSP}">
<style>
html, body {
  width: 100%;
  height: 100%;
  margin: 0;
  background: ${background};
  color: ${foreground};
}
body {
  display: grid;
  place-items: center;
  box-sizing: border-box;
  padding: 16px;
}
svg {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
}
</style>
</head>
<body>
${sanitizedSvg}
</body>
</html>`;
}
