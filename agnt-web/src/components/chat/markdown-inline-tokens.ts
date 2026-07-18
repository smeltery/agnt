const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const BOLD_PATTERN = /\*\*([^*\n]+)\*\*/g;
const ITALIC_PATTERN = /(?<!\w)\*([^*\n]+)\*(?!\w)/g;
const IMAGE_PATTERN = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"([^"\n]*)")?\)/g;
const LINK_PATTERN = /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"([^"\n]*)")?\)/g;
const AUTOLINK_PATTERN = /(?<![\w@:/])\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?\]\)]/g;
const DISPLAY_INLINE_MATH = /\$\$([^$\n]+?)\$\$/g;
const INLINE_MATH = /(?<![\w$])\$([^$\n\s][^$\n]*?[^$\n\s]|[^$\n\s])\$(?![\w$])/g;
const MATH_HINT = /[\\^_{}]/;
const SAFE_LINK_SCHEMES = /^(https?:|mailto:|#)/i;
const SAFE_IMAGE_SCHEMES = /^(https?:|data:image\/)/i;
const HAS_URL_SCHEME = /^[a-z][a-z0-9+\-.]*:/i;

export type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "bold"; value: string }
  | { kind: "italic"; value: string }
  | { kind: "math"; value: string; displayMode: boolean }
  | { kind: "link"; label: string; url: string; title?: string }
  | { kind: "image"; label: string; url: string; title?: string };

interface InlineHit {
  kind: InlineToken["kind"];
  start: number;
  end: number;
  value?: string;
  label?: string;
  url?: string;
  title?: string;
  displayMode?: boolean;
}

export function tokenizeInline(text: string): InlineToken[] {
  const hits: InlineHit[] = [];
  IMAGE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(IMAGE_PATTERN)) {
    if (match.index === undefined) continue;
    const url = match[2];
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
    if (HAS_URL_SCHEME.test(url) && !SAFE_LINK_SCHEMES.test(url)) continue;
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
  DISPLAY_INLINE_MATH.lastIndex = 0;
  for (const match of text.matchAll(DISPLAY_INLINE_MATH)) {
    if (match.index === undefined) continue;
    hits.push({
      kind: "math",
      start: match.index,
      end: match.index + match[0].length,
      value: match[1],
      displayMode: true,
    });
  }
  INLINE_MATH.lastIndex = 0;
  for (const match of text.matchAll(INLINE_MATH)) {
    if (match.index === undefined) continue;
    if (!MATH_HINT.test(match[1])) continue;
    hits.push({
      kind: "math",
      start: match.index,
      end: match.index + match[0].length,
      value: match[1],
      displayMode: false,
    });
  }
  hits.sort((a, b) => a.start - b.start);
  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    if (hit.start > cursor) tokens.push({ kind: "text", value: text.slice(cursor, hit.start) });
    if (hit.kind === "link" || hit.kind === "image") {
      tokens.push({ kind: hit.kind, label: hit.label ?? "", url: hit.url ?? "", title: hit.title });
    } else if (hit.kind === "math") {
      tokens.push({ kind: "math", value: hit.value ?? "", displayMode: hit.displayMode ?? false });
    } else {
      tokens.push({ kind: hit.kind, value: hit.value ?? "" } as InlineToken);
    }
    cursor = hit.end;
  }
  if (cursor < text.length) tokens.push({ kind: "text", value: text.slice(cursor) });
  return tokens;
}
