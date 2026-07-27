const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createThreadListProvenanceEnricher,
} = require("../../src/bridge/thread-list-provenance");

function writeRollout(directory, name, sessionMeta) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, `${JSON.stringify({
    timestamp: "2026-07-25T17:06:51.387Z",
    type: "session_meta",
    payload: sessionMeta,
  })}\n`);
  return filePath;
}

test("fills fork and source provenance Codex leaves null on thread rows", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-thread-provenance-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const originPath = writeRollout(directory, "rollout-origin.jsonl", {
    id: "thread-origin",
    cwd: "/repo",
    thread_source: "user",
  });
  const forkPath = writeRollout(directory, "rollout-fork.jsonl", {
    id: "thread-fork",
    cwd: "/repo",
    forked_from_id: "thread-origin",
    thread_source: "pull_request_fix_automation",
  });

  const enricher = createThreadListProvenanceEnricher();
  const envelope = {
    result: {
      data: [
        { id: "thread-origin", path: originPath, forkedFromId: null, threadSource: null },
        { id: "thread-fork", path: forkPath, forkedFromId: null, threadSource: null },
      ],
    },
  };

  enricher.enrichResponse("thread/list", envelope);

  const [origin, fork] = envelope.result.data;
  assert.equal(origin.forkedFromId, null);
  assert.equal(origin.threadSource, "user");
  assert.equal(fork.forkedFromId, "thread-origin");
  assert.equal(fork.threadSource, "pull_request_fix_automation");
});

test("keeps resolved provenance and enriches single-thread reads", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-thread-provenance-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const filePath = writeRollout(directory, "rollout-fork.jsonl", {
    id: "thread-fork",
    cwd: "/repo",
    forked_from_id: "thread-origin",
    thread_source: "pull_request_fix_automation",
  });
  const enricher = createThreadListProvenanceEnricher({ maxEntries: 2 });

  const resolved = { id: "thread-fork", path: filePath, forkedFromId: "existing", threadSource: "user" };
  enricher.attachToThread(resolved);
  assert.equal(resolved.forkedFromId, "existing");
  assert.equal(resolved.threadSource, "user");

  const envelope = {
    result: { thread: { id: "thread-fork", path: filePath, forkedFromId: null, threadSource: null } },
  };
  enricher.enrichResponse("thread/read", envelope);
  assert.equal(envelope.result.thread.forkedFromId, "thread-origin");
  assert.equal(envelope.result.thread.threadSource, "pull_request_fix_automation");
});
