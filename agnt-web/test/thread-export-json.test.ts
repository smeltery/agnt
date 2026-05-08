// JSON export contract. We're stable on the shape so downstream tools can
// parse it; this test is what locks that promise.

import { describe, expect, it } from "vitest";
import { defaultJsonExportFilename, exportThreadToJson } from "../src/lib/thread-export";
import { createMessage } from "../src/models/message";

const FROZEN = new Date("2026-01-15T12:00:00Z");

describe("exportThreadToJson", () => {
  it("emits a stable schemaVersion + ISO timestamp + thread metadata", () => {
    const out = JSON.parse(
      exportThreadToJson({
        thread: { id: "t1", title: "Refactor auth", cwd: "/tmp/p", modelProvider: "codex", model: "gpt-5" },
        messages: [],
        exportedAt: FROZEN,
      })
    );
    expect(out.schemaVersion).toBe(1);
    expect(out.exportedAt).toBe("2026-01-15T12:00:00.000Z");
    expect(out.thread).toMatchObject({ id: "t1", title: "Refactor auth", cwd: "/tmp/p" });
    expect(out.messages).toEqual([]);
  });

  it("serializes user + assistant messages with role/kind/text", () => {
    const messages = [
      createMessage({ threadId: "t1", role: "user", text: "fix it" }),
      createMessage({ threadId: "t1", role: "assistant", text: "Done." }),
    ];
    const out = JSON.parse(exportThreadToJson({ thread: undefined, messages, exportedAt: FROZEN }));
    expect(out.thread).toBeNull();
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toMatchObject({ role: "user", text: "fix it" });
    expect(out.messages[1]).toMatchObject({ role: "assistant", text: "Done." });
  });

  it("flattens command + fileChange + plan details to stable keys", () => {
    const messages = [
      createMessage({
        threadId: "t1",
        role: "system",
        kind: "commandExecution",
        text: "",
        command: { fullCommand: "ls", outputTail: "a\nb", exitCode: 0 },
      }),
      createMessage({
        threadId: "t1",
        role: "system",
        kind: "fileChange",
        text: "",
        fileChange: { path: "src/x.ts", diff: "+a" },
      }),
    ];
    const out = JSON.parse(exportThreadToJson({ thread: undefined, messages, exportedAt: FROZEN }));
    expect(out.messages[0].command).toEqual({ command: "ls", outputTail: "a\nb", exitCode: 0 });
    expect(out.messages[1].fileChange).toEqual({ path: "src/x.ts", diff: "+a" });
  });

  it("exports image attachments by reference (no payload data URL)", () => {
    const messages = [
      createMessage({
        threadId: "t1",
        role: "user",
        text: "look",
        attachments: [
          {
            id: "a1",
            fileName: "screen.png",
            byteLength: 12345,
            payloadDataUrl: "data:image/png;base64,AAAA",
            thumbnailDataUrl: "data:image/png;base64,BBBB",
          },
        ],
      }),
    ];
    const out = JSON.parse(exportThreadToJson({ thread: undefined, messages, exportedAt: FROZEN }));
    expect(out.messages[0].attachments).toEqual([
      { id: "a1", fileName: "screen.png", byteLength: 12345 },
    ]);
  });
});

describe("defaultJsonExportFilename", () => {
  it("swaps the .md extension for .json", () => {
    const name = defaultJsonExportFilename("Refactor auth");
    expect(name.endsWith(".json")).toBe(true);
    expect(name.endsWith(".md")).toBe(false);
  });
});
