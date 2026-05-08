// Prism wrapper with **lazy** language loading. Prism core ships with the main
// bundle; each language pack is fetched on demand the first time someone
// posts a code fence in that language. Vite handles the dynamic-import
// chunking so a user who never pastes code blocks pays for nothing here.
//
// Prism component files set `Prism.languages.X = ...` as a side effect of
// importing them. They reference siblings via `prism-clike` etc. — those
// inter-component imports work because the component files use ESM's static
// `require`-equivalent inside, which Vite resolves into the same async
// chunks. No manual dependency wiring needed.

import Prism from "prismjs";

const ALIASES: Record<string, string> = {
  shell: "bash",
  sh: "bash",
  zsh: "bash",
  py: "python",
  rs: "rust",
  ts: "typescript",
  yml: "yaml",
};

// Each entry is a thunk so Vite emits one chunk per language that we only
// fetch on first use. Adding a language here is the one-line edit.
const LANGUAGE_LOADERS: Record<string, () => Promise<unknown>> = {
  bash: () => import("prismjs/components/prism-bash"),
  diff: () => import("prismjs/components/prism-diff"),
  go: () => import("prismjs/components/prism-go"),
  json: () => import("prismjs/components/prism-json"),
  jsx: () => import("prismjs/components/prism-jsx"),
  python: () => import("prismjs/components/prism-python"),
  rust: () => import("prismjs/components/prism-rust"),
  swift: () => import("prismjs/components/prism-swift"),
  tsx: () => import("prismjs/components/prism-tsx"),
  typescript: () => import("prismjs/components/prism-typescript"),
  yaml: () => import("prismjs/components/prism-yaml"),
};

const inflight = new Map<string, Promise<void>>();

export function knownLanguage(language: string | undefined): string | null {
  if (!language) return null;
  const normalized = language.trim().toLowerCase();
  if (!normalized) return null;
  const resolved = ALIASES[normalized] ?? normalized;
  return LANGUAGE_LOADERS[resolved] ? resolved : null;
}

/** True when the canonical name has been registered with Prism (synchronous). */
export function isLanguageReady(canonicalName: string): boolean {
  return Boolean(Prism.languages[canonicalName]);
}

/**
 * Kicks off the dynamic import for a language and resolves once the grammar
 * is registered. Idempotent — repeated calls share the same in-flight promise
 * and resolve immediately if the grammar is already present.
 */
export async function ensureLanguage(canonicalName: string): Promise<boolean> {
  if (isLanguageReady(canonicalName)) return true;
  const loader = LANGUAGE_LOADERS[canonicalName];
  if (!loader) return false;
  let pending = inflight.get(canonicalName);
  if (!pending) {
    pending = loader().then(
      () => undefined,
      (error) => {
        // A failed import (offline, blocked) should clear so a later retry
        // can succeed once connectivity is back.
        inflight.delete(canonicalName);
        throw error;
      }
    );
    inflight.set(canonicalName, pending);
  }
  await pending;
  return isLanguageReady(canonicalName);
}

export function highlightCode(source: string, canonicalName: string): string {
  const grammar = Prism.languages[canonicalName];
  if (!grammar) return escapeHtml(source);
  return Prism.highlight(source, grammar, canonicalName);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
