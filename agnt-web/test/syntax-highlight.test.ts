import { describe, expect, it } from "vitest";
import {
  ensureLanguage,
  escapeHtml,
  highlightCode,
  isLanguageReady,
  knownLanguage,
} from "../src/components/chat/syntax-highlight";

describe("syntax highlighter (lazy)", () => {
  it("resolves common aliases against the registered loader map", () => {
    expect(knownLanguage("ts")).toBe("typescript");
    expect(knownLanguage("YML")).toBe("yaml");
    expect(knownLanguage("py")).toBe("python");
    expect(knownLanguage("Bash")).toBe("bash");
  });

  it("returns null for languages we deliberately don't ship loaders for", () => {
    expect(knownLanguage("brainfuck")).toBeNull();
    expect(knownLanguage(undefined)).toBeNull();
    expect(knownLanguage("  ")).toBeNull();
  });

  it("escapes HTML special characters when called against an unknown language", () => {
    expect(highlightCode("<script>alert(1)</script>", "unknown-lang-xyz")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
  });

  it("escapeHtml is exported as a stable building block for the lazy fallback path", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe(
      "&lt;a href=\"x\"&gt;&amp;&lt;/a&gt;"
    );
  });

  it("ensureLanguage resolves once the grammar registers (typescript pulls in javascript+clike via Vite chunking)", async () => {
    expect(isLanguageReady("typescript")).toBe(false);
    const ok = await ensureLanguage("typescript");
    expect(ok).toBe(true);
    expect(isLanguageReady("typescript")).toBe(true);
    // Subsequent calls short-circuit synchronously (still resolved promise).
    expect(await ensureLanguage("typescript")).toBe(true);
    // Highlighter now produces real Prism token spans.
    expect(highlightCode("const x = 1;", "typescript")).toContain('<span class="token keyword">const</span>');
  });

  it("ensureLanguage returns false for languages we don't have a loader for", async () => {
    expect(await ensureLanguage("brainfuck")).toBe(false);
  });
});
