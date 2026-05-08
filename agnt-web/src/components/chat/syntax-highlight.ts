// Prism wrapper with a curated language pack. We ship the languages the agent
// most often emits (bash/diff/json/typescript/python/yaml/rust/go/swift) and
// fall back to plain monospace for everything else. Static imports keep the
// build deterministic; the whole pack adds ~15 KB gzipped to the main bundle.

import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-go";
import "prismjs/components/prism-json";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-yaml";

const ALIASES: Record<string, string> = {
  shell: "bash",
  sh: "bash",
  zsh: "bash",
  py: "python",
  rs: "rust",
  ts: "typescript",
  yml: "yaml",
};

export function resolveLanguage(language: string | undefined): string | null {
  if (!language) return null;
  const normalized = language.trim().toLowerCase();
  if (!normalized) return null;
  const resolved = ALIASES[normalized] ?? normalized;
  return Prism.languages[resolved] ? resolved : null;
}

export function highlightCode(source: string, language: string): string {
  const grammar = Prism.languages[language];
  if (!grammar) return escapeHtml(source);
  return Prism.highlight(source, grammar, language);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
