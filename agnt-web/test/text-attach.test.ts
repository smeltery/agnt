import { describe, expect, it } from "vitest";
import { attachmentFromTextFile, buildFencedSnippet, looksLikeTextFile, TextAttachError } from "../src/lib/text-attach";

function makeFile(name: string, content: string, type = ""): File {
  return new File([content], name, { type });
}

describe("looksLikeTextFile", () => {
  it("accepts files with text/* MIME types", () => {
    expect(looksLikeTextFile(makeFile("notes.txt", "hi", "text/plain"))).toBe(true);
    expect(looksLikeTextFile(makeFile("page.html", "<p>", "text/html"))).toBe(true);
  });

  it("accepts JSON / XML / YAML application MIME types", () => {
    expect(looksLikeTextFile(makeFile("a.json", "{}", "application/json"))).toBe(true);
    expect(looksLikeTextFile(makeFile("a.yaml", "x:1", "application/yaml"))).toBe(true);
  });

  it("falls back to extension allowlist when MIME is empty (browsers do this for .ts)", () => {
    expect(looksLikeTextFile(makeFile("foo.ts", "// hi"))).toBe(true);
    expect(looksLikeTextFile(makeFile("Dockerfile", "FROM"))).toBe(true);
    expect(looksLikeTextFile(makeFile("server.go", "package main"))).toBe(true);
  });

  it("rejects unknown extensions and binary MIME types", () => {
    expect(looksLikeTextFile(makeFile("video.mov", "", "video/quicktime"))).toBe(false);
    expect(looksLikeTextFile(makeFile("brand.brand", "anything"))).toBe(false);
  });
});

describe("buildFencedSnippet", () => {
  it("infers the fence language from the file extension", () => {
    expect(buildFencedSnippet("foo.ts", "const x = 1;")).toContain("```ts");
    expect(buildFencedSnippet("script.py", "x = 1")).toContain("```python");
    expect(buildFencedSnippet("config.yaml", "x: 1")).toContain("```yaml");
  });

  it("escapes the fence by lengthening it past any backtick run inside the file", () => {
    const content = "echo ```hi```";
    const fenced = buildFencedSnippet("readme.md", content);
    expect(fenced).toContain("````markdown");
    expect(fenced).toContain("```hi```");
    // The closing fence is exactly four backticks on its own line, after the
    // body, with at most a trailing newline. (We don't assert exact tail
    // whitespace because trimEnd() strips trailing newlines from the body
    // before the closing fence.)
    expect(fenced).toMatch(/\n````$/);
  });

  it("includes a bold filename header so the agent sees what was attached", () => {
    expect(buildFencedSnippet("notes.txt", "hi")).toMatch(/^\*\*notes\.txt\*\*/);
  });
});

describe("attachmentFromTextFile", () => {
  it("rejects unrecognized file types before reading", async () => {
    await expect(attachmentFromTextFile(makeFile("video.mov", "x", "video/quicktime"))).rejects.toBeInstanceOf(
      TextAttachError
    );
  });

  it("rejects files larger than the cap", async () => {
    const big = "x".repeat(300 * 1024);
    const file = makeFile("notes.txt", big, "text/plain");
    await expect(attachmentFromTextFile(file)).rejects.toMatchObject({ code: "size" });
  });

  it("returns a fenced snippet plus metadata for a normal text file", async () => {
    const file = makeFile("greet.ts", "export const hi = () => 'hi';", "");
    const result = await attachmentFromTextFile(file);
    expect(result.fileName).toBe("greet.ts");
    expect(result.byteLength).toBe(file.size);
    expect(result.fenced).toContain("```ts");
    expect(result.fenced).toContain("export const hi");
  });
});
