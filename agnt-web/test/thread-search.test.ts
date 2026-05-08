import { describe, expect, it } from "vitest";
import { searchableText } from "../src/components/chat/ThreadSearchBar";
import { createMessage, orderCounter } from "../src/models";

function reset() {
  orderCounter.__resetForTests();
}

describe("searchableText", () => {
  it("includes the message text", () => {
    reset();
    const message = createMessage({ threadId: "t", role: "assistant", text: "hello world" });
    expect(searchableText(message)).toContain("hello world");
  });

  it("merges command full-command + output so users can grep terminal noise", () => {
    reset();
    const message = createMessage({
      threadId: "t",
      role: "system",
      kind: "commandExecution",
      command: { fullCommand: "npm test", outputTail: "PASS audio-encode\n", exitCode: 0, durationMs: 12 },
    });
    const blob = searchableText(message);
    expect(blob).toContain("npm test");
    expect(blob).toContain("PASS audio-encode");
  });

  it("merges file-change diffs so a path inside a hunk is searchable", () => {
    reset();
    const message = createMessage({
      threadId: "t",
      role: "system",
      kind: "fileChange",
      fileChange: { path: "src/foo.ts", diff: "@@\n-old\n+new" },
    });
    expect(searchableText(message)).toContain("+new");
  });

  it("flattens plan steps and explanation so the bar can find a step's text", () => {
    reset();
    const message = createMessage({
      threadId: "t",
      role: "system",
      kind: "plan",
      plan: {
        presentation: "progress",
        explanation: "two steps",
        steps: [
          { step: "audit", status: "completed" },
          { step: "patch the form", status: "in_progress" },
        ],
      },
    });
    const blob = searchableText(message);
    expect(blob).toContain("two steps");
    expect(blob).toContain("audit");
    expect(blob).toContain("patch the form");
  });

  it("returns empty string for messages with no text-like content", () => {
    reset();
    const message = createMessage({ threadId: "t", role: "system", kind: "thinking", text: "" });
    expect(searchableText(message)).toBe("");
  });
});
