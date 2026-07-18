import { describe, expect, it } from "vitest";
import { collectAssistantChangeSet } from "../src/lib/assistant-change-set";
import { createMessage } from "../src/models";

describe("collectAssistantChangeSet", () => {
  it("aggregates file changes for the assistant turn only", () => {
    const assistant = createMessage({
      id: "assistant-1",
      threadId: "thread-1",
      role: "assistant",
      turnId: "turn-1",
      text: "Done",
    });
    const summary = collectAssistantChangeSet(
      [
        assistant,
        createMessage({
          id: "change-1",
          threadId: "thread-1",
          role: "system",
          kind: "fileChange",
          turnId: "turn-1",
          fileChange: { path: "src/a.ts", diff: "diff --git a/src/a.ts b/src/a.ts\n@@\n-old\n+new" },
        }),
        createMessage({
          id: "other-thread",
          threadId: "thread-2",
          role: "system",
          kind: "fileChange",
          turnId: "turn-1",
          fileChange: { path: "src/b.ts", diff: "@@\n-a\n+b" },
        }),
        createMessage({
          id: "other-turn",
          threadId: "thread-1",
          role: "system",
          kind: "fileChange",
          turnId: "turn-2",
          fileChange: { path: "src/c.ts", diff: "@@\n-a\n+b" },
        }),
      ],
      assistant
    );

    expect(summary).toEqual({
      count: 1,
      firstId: "change-1",
      insertions: 1,
      deletions: 1,
      patches: [
        {
          id: "change-1",
          path: "src/a.ts",
          forwardPatch: "diff --git a/src/a.ts b/src/a.ts\n@@\n-old\n+new\n",
        },
      ],
    });
  });

  it("returns null without a turn or file-change diff", () => {
    const assistant = createMessage({
      threadId: "thread-1",
      role: "assistant",
      text: "Done",
    });

    expect(collectAssistantChangeSet([], assistant)).toBeNull();
  });
});
