import { describe, expect, it } from "vitest";
import { highlightCode, resolveLanguage } from "../src/components/chat/syntax-highlight";

describe("syntax highlighter", () => {
  it("resolves common aliases", () => {
    expect(resolveLanguage("ts")).toBe("typescript");
    expect(resolveLanguage("YML")).toBe("yaml");
    expect(resolveLanguage("py")).toBe("python");
    expect(resolveLanguage("Bash")).toBe("bash");
  });

  it("returns null for unknown languages", () => {
    expect(resolveLanguage("brainfuck")).toBeNull();
    expect(resolveLanguage(undefined)).toBeNull();
    expect(resolveLanguage("  ")).toBeNull();
  });

  it("emits Prism token spans for a known language", () => {
    const html = highlightCode("const x = 1;", "typescript");
    expect(html).toContain('<span class="token keyword">const</span>');
  });

  it("escapes HTML special characters when no grammar is available", () => {
    expect(highlightCode("<script>alert(1)</script>", "unknown-lang-xyz")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
  });
});
