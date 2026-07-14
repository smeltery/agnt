const test = require("node:test");
const assert = require("node:assert/strict");

const {
  augmentRelayThreadWithJsonlMetadata,
  sanitizeThreadHistoryImagesForRelay,
} = require("../../src/bridge/relay-payload-pipeline");

test("sanitizeThreadHistoryImagesForRelay augments Codex thread cwd from matching JSONL metadata", () => {
  const raw = JSON.stringify({
    id: "r-jsonl-cwd",
    result: { thread: {
      id: "thread-jsonl-cwd",
      turns: [{ id: "turn-1", items: [{ id: "item-1", type: "message", text: "hi" }] }],
    } },
  });
  const fsModule = makeJsonlFs({
    "/sessions/rollout-thread-jsonl-cwd.jsonl": {
      mtimeMs: 1,
      content: `${JSON.stringify({
        type: "session_meta",
        payload: { id: "thread-jsonl-cwd", cwd: "/Users/me/project" },
      })}\n`,
    },
  });

  const out = sanitizeThreadHistoryImagesForRelay(raw, "thread/read", {
    activeProviderId: "codex",
    resolveSessionsRootImpl: () => "/sessions",
    findRecentRolloutFileForContextReadImpl: () => "/sessions/rollout-thread-jsonl-cwd.jsonl",
    fsModule,
  });
  const rewritten = JSON.parse(out);

  assert.equal(rewritten.result.thread.cwd, "/Users/me/project");
  assert.equal(rewritten.result.thread.current_working_directory, "/Users/me/project");
});

test("sanitizeThreadHistoryImagesForRelay skips JSONL cwd augmentation for non-Codex providers", () => {
  const raw = JSON.stringify({
    id: "r-jsonl-cwd-noncodex",
    result: { thread: {
      id: "thread-jsonl-cwd-noncodex",
      turns: [{ id: "turn-1", items: [{ id: "item-1", type: "message", text: "hi" }] }],
    } },
  });

  assert.equal(
    sanitizeThreadHistoryImagesForRelay(raw, "thread/read", {
      activeProviderId: "claude",
      resolveSessionsRootImpl: () => {
        throw new Error("must not inspect Codex rollout files");
      },
    }),
    raw
  );
});

test("augmentRelayThreadWithJsonlMetadata refreshes cwd when rollout identity changes", () => {
  let currentPath = "/sessions/rollout-thread-jsonl-cwd-refresh-old.jsonl";
  let nowValue = 1_000;
  const fsModule = makeJsonlFs({
    "/sessions/rollout-thread-jsonl-cwd-refresh-old.jsonl": {
      mtimeMs: 1,
      content: `${JSON.stringify({
        type: "session_meta",
        payload: { id: "thread-jsonl-cwd-refresh", cwd: "/Users/me/old" },
      })}\n`,
    },
    "/sessions/rollout-thread-jsonl-cwd-refresh-new.jsonl": {
      mtimeMs: 2,
      content: `${JSON.stringify({
        type: "session_meta",
        payload: { id: "thread-jsonl-cwd-refresh", cwd: "/Users/me/new" },
      })}\n`,
    },
  });
  const deps = {
    resolveSessionsRootImpl: () => "/sessions",
    findRecentRolloutFileForContextReadImpl: () => currentPath,
    fsModule,
    now: () => nowValue,
  };

  const first = augmentRelayThreadWithJsonlMetadata(
    { id: "thread-jsonl-cwd-refresh", turns: [] },
    "thread-jsonl-cwd-refresh",
    deps
  );
  assert.equal(first.thread.cwd, "/Users/me/old");

  currentPath = "/sessions/rollout-thread-jsonl-cwd-refresh-new.jsonl";
  nowValue += 1;
  const second = augmentRelayThreadWithJsonlMetadata(
    { id: "thread-jsonl-cwd-refresh", turns: [] },
    "thread-jsonl-cwd-refresh",
    deps
  );
  assert.equal(second.thread.cwd, "/Users/me/new");
});

function makeJsonlFs(files) {
  return {
    statSync(filePath) {
      const file = files[filePath];
      if (!file) {
        throw new Error(`missing file ${filePath}`);
      }
      return {
        mtimeMs: file.mtimeMs,
        size: Buffer.byteLength(file.content, "utf8"),
      };
    },
    readFileSync(filePath) {
      const file = files[filePath];
      if (!file) {
        throw new Error(`missing file ${filePath}`);
      }
      return file.content;
    },
  };
}
