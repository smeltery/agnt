// Smoke test for the bulk-export concatenator. The single-thread path already
// has implicit coverage via the sidebar context-menu export; here we just want
// to confirm headers per thread + separator rules don't drop messages.

import { describe, expect, it } from "vitest";
import { exportThreadsToMarkdown } from "../src/lib/thread-export";
import { createMessage } from "../src/models/message";

function makeThread(id: string, title: string) {
  return {
    id,
    title,
    name: title,
    cwd: "/tmp/x",
    modelProvider: "codex",
    model: "test",
  } as const;
}

describe("exportThreadsToMarkdown", () => {
  it("renders one header per thread with horizontal-rule separators", () => {
    const exportedAt = new Date("2026-01-01T00:00:00Z");
    const out = exportThreadsToMarkdown(
      [
        {
          thread: makeThread("a", "Alpha"),
          messages: [createMessage({ threadId: "a", role: "user", text: "hi" })],
        },
        {
          thread: makeThread("b", "Beta"),
          messages: [createMessage({ threadId: "b", role: "assistant", text: "hello" })],
        },
      ],
      exportedAt
    );
    expect(out).toContain("# Threads export (2)");
    expect(out).toContain("# Alpha");
    expect(out).toContain("# Beta");
    expect(out).toContain("hi");
    expect(out).toContain("hello");
    // Two threads = at least two `---` separators between the threads, plus
    // the leading one after the global header.
    const hrCount = (out.match(/^---$/gm) ?? []).length;
    expect(hrCount).toBeGreaterThanOrEqual(3);
  });

  it("handles a single-thread export without producing dangling separators", () => {
    const out = exportThreadsToMarkdown(
      [
        {
          thread: makeThread("a", "Solo"),
          messages: [createMessage({ threadId: "a", role: "user", text: "x" })],
        },
      ],
      new Date(0)
    );
    expect(out).toContain("# Threads export (1)");
    expect(out).toContain("# Solo");
    // Trim trailing whitespace/newlines for the dangling-separator assertion.
    expect(out.trimEnd().endsWith("---")).toBe(true);
  });
});
