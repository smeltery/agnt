import { describe, expect, it } from "vitest";
import { createMessage, orderCounter } from "../src/models";
import { defaultExportFilename, exportThreadToMarkdown } from "../src/lib/thread-export";

function reset() {
  orderCounter.__resetForTests();
}

describe("exportThreadToMarkdown", () => {
  it("builds a header from thread metadata and a stable exportedAt timestamp", () => {
    reset();
    const md = exportThreadToMarkdown({
      thread: { id: "t", title: "Refactor auth", cwd: "/repo", modelProvider: "claude", model: "sonnet-4-5", name: undefined },
      messages: [],
      exportedAt: new Date("2026-05-08T12:00:00Z"),
    });
    expect(md).toContain("# Refactor auth");
    expect(md).toContain("- **cwd:** `/repo`");
    expect(md).toContain("- **provider:** claude");
    expect(md).toContain("- **model:** `sonnet-4-5`");
    expect(md).toContain("- **exported:** 2026-05-08T12:00:00.000Z");
  });

  it("falls back to 'Untitled thread' when neither name nor title is set", () => {
    reset();
    const md = exportThreadToMarkdown({ thread: undefined, messages: [], exportedAt: new Date() });
    expect(md).toContain("# Untitled thread");
  });

  it("renders user / assistant / reasoning / failed-turn / plan / command rows in document order", () => {
    reset();
    const messages = [
      createMessage({ threadId: "t", role: "user", text: "fix the login bug" }),
      createMessage({ threadId: "t", role: "system", kind: "thinking", text: "weighing options" }),
      createMessage({ threadId: "t", role: "assistant", text: "Here's the fix." }),
      createMessage({
        threadId: "t",
        role: "system",
        kind: "commandExecution",
        command: { fullCommand: "npm test", outputTail: "ok\n", exitCode: 0, durationMs: 1234 },
      }),
      createMessage({
        threadId: "t",
        role: "system",
        kind: "fileChange",
        fileChange: { path: "src/login.ts", diff: "@@ -1,3 +1,3 @@\n-old\n+new" },
      }),
      createMessage({
        threadId: "t",
        role: "system",
        kind: "plan",
        plan: {
          presentation: "resultReady",
          explanation: "two-step",
          steps: [
            { step: "audit", status: "completed" },
            { step: "patch", status: "in_progress" },
          ],
        },
      }),
      createMessage({
        threadId: "t",
        role: "system",
        kind: "chat",
        text: "rate_limit_exceeded",
        deliveryState: "failed",
      }),
    ];
    const md = exportThreadToMarkdown({ thread: { id: "t", title: "x" }, messages, exportedAt: new Date() });
    expect(md).toContain("## You");
    expect(md).toContain("fix the login bug");
    expect(md).toContain("<summary>Reasoning</summary>");
    expect(md).toContain("## Assistant\n\nHere's the fix.");
    expect(md).toContain("```bash\nnpm test\n```");
    expect(md).toContain("<summary>Output</summary>");
    expect(md).toMatch(/exit 0.*1\.23s/);
    expect(md).toContain("### File change — `src/login.ts`");
    expect(md).toContain("```diff");
    expect(md).toContain("- [x] audit");
    expect(md).toContain("- [ ] patch");
    expect(md).toContain("> ⚠ Turn failed: rate_limit_exceeded");
  });

  it("omits empty assistant rows so steered turns don't leave blank sections", () => {
    reset();
    const md = exportThreadToMarkdown({
      thread: { id: "t", title: "x" },
      messages: [
        createMessage({ threadId: "t", role: "user", text: "hi" }),
        createMessage({ threadId: "t", role: "assistant", text: "   " }),
        createMessage({ threadId: "t", role: "assistant", text: "Hello!" }),
      ],
      exportedAt: new Date(),
    });
    expect(md.match(/## Assistant/g)?.length).toBe(1);
    expect(md).toContain("Hello!");
  });

  it("ends in a single trailing newline so unix tools play nice", () => {
    reset();
    const md = exportThreadToMarkdown({ thread: undefined, messages: [], exportedAt: new Date() });
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });
});

describe("defaultExportFilename", () => {
  it("slugifies the title and appends an ISO-ish timestamp", () => {
    const filename = defaultExportFilename("Refactor: AUTH flow!");
    expect(filename).toMatch(/^refactor-auth-flow-\d{4}-\d{2}-\d{2}T/);
    expect(filename.endsWith(".md")).toBe(true);
  });

  it("defaults to 'thread' when the title is empty / undefined / unsluggable", () => {
    expect(defaultExportFilename(undefined)).toMatch(/^thread-/);
    expect(defaultExportFilename("")).toMatch(/^thread-/);
    expect(defaultExportFilename("!!!")).toMatch(/^thread-/);
  });
});
