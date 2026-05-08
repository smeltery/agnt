// Text-file ingest. Mirrors lib/image-attach.ts in shape, but produces a
// fenced code block to splice into the composer draft instead of an image
// attachment — the bridge protocol has no first-class "text file" attachment
// type, and pasting the contents inline preserves token cost transparency
// (the user can see exactly what the agent is about to read).
//
// We accept "obvious text" only: extensions like .ts/.py/.md/.log, or MIME
// types that start with text/ or are explicitly application/json,
// application/xml, application/yaml. Binary uploads should go through the
// image-attach pipeline (or be rejected).

const SIZE_CAP_BYTES = 256 * 1024; // 256 KB — anything bigger would push older messages out of context anyway

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "mdx",
  "markdown",
  "rst",
  "log",
  "json",
  "jsonc",
  "json5",
  "yml",
  "yaml",
  "toml",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "swift",
  "java",
  "kt",
  "kts",
  "scala",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "lua",
  "pl",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "sql",
  "graphql",
  "gql",
  "proto",
  "diff",
  "patch",
  "env",
  "ini",
  "cfg",
  "conf",
  "make",
  "mk",
  "dockerfile",
  "gitignore",
  "gitattributes",
  "tf",
  "tfvars",
  "vue",
  "svelte",
  "astro",
]);

const FENCE_LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  swift: "swift",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  lua: "lua",
  pl: "perl",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  ps1: "powershell",
  sql: "sql",
  json: "json",
  jsonc: "json",
  json5: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  rst: "rst",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  diff: "diff",
  patch: "diff",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  vue: "vue",
  svelte: "svelte",
  tf: "hcl",
  tfvars: "hcl",
};

export class TextAttachError extends Error {
  constructor(message: string, public code: "type" | "size" | "decode") {
    super(message);
    this.name = "TextAttachError";
  }
}

export function looksLikeTextFile(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  if (file.type === "application/json" || file.type === "application/xml" || file.type === "application/yaml") {
    return true;
  }
  if (TEXT_EXTENSIONS.has(extensionOf(file.name))) return true;
  // Some browsers don't infer a MIME for unusual extensions like .ts (because
  // .ts is also "MPEG transport stream"). The extension allowlist above
  // catches the source-code cases; otherwise we refuse rather than guess.
  return false;
}

export interface TextAttachment {
  /** Markdown snippet ready to splice into the composer draft. */
  fenced: string;
  fileName: string;
  byteLength: number;
}

export async function attachmentFromTextFile(file: File): Promise<TextAttachment> {
  if (!looksLikeTextFile(file)) {
    throw new TextAttachError(`Refusing to attach \`${file.name || "file"}\` — not a recognized text file.`, "type");
  }
  if (file.size > SIZE_CAP_BYTES) {
    throw new TextAttachError(
      `\`${file.name || "file"}\` is ${(file.size / 1024).toFixed(0)} KB; the cap is ${(SIZE_CAP_BYTES / 1024).toFixed(0)} KB so the prompt stays a sensible size.`,
      "size"
    );
  }
  const text = await readFileAsText(file).catch(() => null);
  if (text === null) throw new TextAttachError("Could not decode file as text.", "decode");
  return {
    fileName: file.name || "attachment.txt",
    byteLength: file.size,
    fenced: buildFencedSnippet(file.name, text),
  };
}

export function buildFencedSnippet(fileName: string, content: string): string {
  const language = FENCE_LANGUAGE_BY_EXT[extensionOf(fileName)] ?? "";
  // Pick a fence longer than any backtick run inside the file so we don't
  // truncate accidentally. Common case is 3 backticks; we just bump up if the
  // file already contains them.
  const longestRun = longestBacktickRun(content);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const header = `${fence}${language}`;
  const closing = fence;
  return `${fileName ? `**${fileName}**\n\n` : ""}${header}\n${content.trimEnd()}\n${closing}`;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === "`") {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

function extensionOf(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex < 0) return fileName.toLowerCase();
  return fileName.slice(dotIndex + 1).toLowerCase();
}

async function readFileAsText(file: Blob): Promise<string> {
  // Blob.text() is universally supported in modern browsers and works in
  // vitest's node environment without a FileReader polyfill. The earlier
  // FileReader-based implementation would silently fail tests.
  if (typeof (file as Blob & { text?: () => Promise<string> }).text === "function") {
    return await file.text();
  }
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new TextAttachError("File reader returned non-string result.", "decode"));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(new TextAttachError("File read failed.", "decode"));
    reader.readAsText(file);
  });
}
