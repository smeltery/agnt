const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { __test, handleGitRequest } = require("../../src/git/git-handler");
const { git, makeTempRepo } = require("./git-handler-test-helpers");
const { createWorktreeUsageVerifier, assertInactiveCatalogsEmpty } = require("../../src/providers/worktree-usage");

async function fixture(fn) {
  const repo = makeTempRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-cleanup-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const result = await __test.gitCreateWorktree(repo, { name: "feature/cleanup" });
    await fn({ repo, root: result.worktreePath, branch: result.branch });
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const kind of ["untracked", "ignored", "tracked"]) {
  test(`cleanup preserves ${kind} files and the Git registration`, async () => fixture(async ({ root, repo, branch }) => {
    if (kind === "ignored") {
      fs.writeFileSync(path.join(root, ".gitignore"), "keep.local\n"); git(root, "add", ".gitignore"); git(root, "commit", "-m", "Ignore local file");
    }
    const filename = kind === "tracked" ? "README.md" : "keep.local";
    fs.writeFileSync(path.join(root, filename), "must survive\n");
    await assert.rejects(__test.gitRemoveWorktree(root, { branch }), (error) => error.errorCode === "worktree_not_clean");
    assert.ok(fs.existsSync(path.join(root, filename)));
    assert.ok(git(repo, "worktree", "list", "--porcelain").includes(root));
  }));
}

test("cleanup retains unmerged commits and rejects a mismatched branch", async () => fixture(async ({ root, repo, branch }) => {
  await assert.rejects(__test.gitRemoveWorktree(root, { branch: "main" }), (error) => error.errorCode === "worktree_branch_mismatch");
  fs.writeFileSync(path.join(root, "unique.txt"), "keep commit\n"); git(root, "add", "unique.txt"); git(root, "commit", "-m", "Unique work");
  const result = await __test.gitRemoveWorktree(root, { branch });
  assert.equal(result.removedBranch, false);
  assert.equal(fs.existsSync(root), false);
  assert.match(git(repo, "show", `${branch}:unique.txt`), /keep commit/);
}));

test("manual cleanup lists checkouts and requires complete chat-usage verification", async () => fixture(async ({ root, repo, branch }) => {
  const list = await __test.gitListManagedWorktrees(repo);
  assert.ok(list.worktrees.some((entry) => entry.path === root && entry.isClean));
  const response = await new Promise((resolve) => handleGitRequest(JSON.stringify({ id: 1, method: "git/removeWorktreeSafely", params: { cwd: root } }),
    (raw) => resolve(JSON.parse(raw))));
  assert.equal(response.error.data.errorCode, "worktree_usage_unknown");
  assert.ok(fs.existsSync(root));
}));

test("usage checks include archived catalogs, subfolders and pagination", async () => {
  const calls = [];
  const verify = createWorktreeUsageVerifier({ activeProvider: { id: "test" }, verifyInactive: async () => {},
    sendRequest: async (method, params) => {
      calls.push(params);
      if (params.archived) return { data: [{ id: "old", cwd: "/project/worktree/subdir" }] };
      return params.cursor ? { data: [] } : { data: [], nextCursor: "next" };
    },
  });
  await assert.rejects(verify("/project/worktree"), /still uses/);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].archived, true);
});

test("incomplete or cyclic catalogs cannot authorize deletion", async () => {
  for (const result of [{ data: [], hasMore: true }, { data: [], nextCursor: "same" }]) {
    const verify = createWorktreeUsageVerifier({ activeProvider: { id: "test" }, verifyInactive: async () => {}, sendRequest: async () => result });
    await assert.rejects(verify("/project/worktree"), /incomplete|completely verified/);
  }
});

test("inactive runtime state blocks unverifiable cleanup, but an absent catalog does not", async () => {
  const providers = [{ id: "other", displayName: "Other", sessionsDir: () => "/other" }];
  await assert.rejects(assertInactiveCatalogsEmpty("active", providers, { readdirSync: () => ["session"] }), /inactive/);
  await assertInactiveCatalogsEmpty("active", providers, { readdirSync() { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
});
