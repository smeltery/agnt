import { knownLanguage } from "../components/chat/syntax-highlight";

const NAME_LANGUAGES: Record<string, string> = {
  dockerfile: "bash",
  makefile: "bash",
};

const EXTENSION_LANGUAGES: Record<string, string> = {
  bash: "bash",
  diff: "diff",
  go: "go",
  js: "jsx",
  jsx: "jsx",
  json: "json",
  py: "python",
  rs: "rust",
  sh: "bash",
  swift: "swift",
  ts: "typescript",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

export function isLocalWorkspaceLink(url: string): boolean {
  if (!url) return false;
  if (url.startsWith("#")) return false;
  return !/^[a-z][a-z0-9+\-.]*:/i.test(url);
}

export function languageForWorkspacePath(path: string): string | null {
  const clean = path.split(/[?#]/, 1)[0] ?? path;
  const fileName = clean.split(/[\\/]/).filter(Boolean).pop() ?? clean;
  const lowerName = fileName.toLowerCase();
  const byName = NAME_LANGUAGES[lowerName];
  if (byName) return knownLanguage(byName);
  const dot = lowerName.lastIndexOf(".");
  if (dot < 0 || dot === lowerName.length - 1) return null;
  return knownLanguage(EXTENSION_LANGUAGES[lowerName.slice(dot + 1)] ?? lowerName.slice(dot + 1));
}

export function formatWorkspaceFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}
