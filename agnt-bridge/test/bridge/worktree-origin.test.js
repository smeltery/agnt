const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createWorktreeOriginEnricher } = require("../../src/bridge/worktree-origin");

function makeCodexHomeWithWorktree({ token, repoName, checkoutRoot, worktreeName = repoName }) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const worktreeRoot = path.join(codexHome, "worktrees", token, repoName);
  fs.mkdirSync(worktreeRoot, { recursive: true });
  fs.writeFileSync(
    path.join(worktreeRoot, ".git"),
    `gitdir: ${path.join(checkoutRoot, ".git", "worktrees", worktreeName)}\n`
  );
  return { codexHome, worktreeRoot };
}

test("groups managed worktree rows under the checkout that owns them", (t) => {
  const checkoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-checkout-"));
  const { codexHome, worktreeRoot } = makeCodexHomeWithWorktree({
    token: "22f1",
    repoName: "agnt",
    checkoutRoot,
    worktreeName: "agnt6",
  });
  t.after(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(checkoutRoot, { recursive: true, force: true });
  });

  const enricher = createWorktreeOriginEnricher({ codexHome });
  const envelope = {
    result: {
      data: [
        { id: "thread-local", cwd: checkoutRoot },
        { id: "thread-worktree", cwd: worktreeRoot },
      ],
    },
  };

  enricher.enrichResponse("thread/list", envelope);

  const [local, worktree] = envelope.result.data;
  assert.equal(local.worktreeOriginPath, undefined);
  assert.equal(worktree.worktreeOriginPath, checkoutRoot);
});

test("mirrors package-scoped worktree chats onto the matching checkout subpath", (t) => {
  const checkoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-checkout-"));
  fs.mkdirSync(path.join(checkoutRoot, "packages", "app"), { recursive: true });
  const { codexHome, worktreeRoot } = makeCodexHomeWithWorktree({
    token: "45b5",
    repoName: "agnt",
    checkoutRoot,
  });
  t.after(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(checkoutRoot, { recursive: true, force: true });
  });

  const enricher = createWorktreeOriginEnricher({ codexHome });
  const envelope = {
    result: {
      thread: { id: "thread-scoped", cwd: path.join(worktreeRoot, "packages", "app") },
    },
  };

  enricher.enrichResponse("thread/read", envelope);

  assert.equal(envelope.result.thread.worktreeOriginPath, path.join(checkoutRoot, "packages", "app"));
});

test("leaves rows alone outside managed worktrees, without an owner, or already resolved", (t) => {
  const checkoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-checkout-"));
  const { codexHome, worktreeRoot } = makeCodexHomeWithWorktree({
    token: "606d",
    repoName: "agnt",
    checkoutRoot,
  });
  const orphanWorktreeRoot = path.join(codexHome, "worktrees", "64e5", "agnt");
  fs.mkdirSync(orphanWorktreeRoot, { recursive: true });
  t.after(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(checkoutRoot, { recursive: true, force: true });
  });

  const enricher = createWorktreeOriginEnricher({ codexHome });
  const rows = [
    { id: "no-cwd" },
    { id: "outside", cwd: checkoutRoot },
    { id: "worktrees-root", cwd: path.join(codexHome, "worktrees") },
    { id: "orphan", cwd: orphanWorktreeRoot },
    { id: "resolved", cwd: worktreeRoot, worktreeOriginPath: "/already/known" },
  ];

  for (const row of rows) {
    enricher.attachToThread(row);
  }

  assert.deepEqual(rows.map((row) => row.worktreeOriginPath), [
    undefined,
    undefined,
    undefined,
    undefined,
    "/already/known",
  ]);
});
