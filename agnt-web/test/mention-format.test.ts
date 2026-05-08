// formatMentionPath turns the absolute path the bridge returns into a
// relative path against the active thread's cwd. Falls back to absolute
// when the path doesn't sit under cwd.

import { describe, expect, it } from "vitest";
import { formatMentionPath } from "../src/lib/file-mention";

describe("formatMentionPath", () => {
  it("strips the cwd prefix (with or without trailing slash)", () => {
    expect(formatMentionPath("/Users/me/proj/src/foo.ts", "/Users/me/proj")).toBe("src/foo.ts");
    expect(formatMentionPath("/Users/me/proj/src/foo.ts", "/Users/me/proj/")).toBe("src/foo.ts");
  });

  it("returns '.' when the path equals cwd", () => {
    expect(formatMentionPath("/Users/me/proj", "/Users/me/proj")).toBe(".");
  });

  it("falls back to the absolute path when not under cwd", () => {
    expect(formatMentionPath("/etc/hosts", "/Users/me/proj")).toBe("/etc/hosts");
  });

  it("returns the absolute path when cwd is empty", () => {
    expect(formatMentionPath("/Users/me/proj/src/foo.ts", "")).toBe("/Users/me/proj/src/foo.ts");
  });
});
