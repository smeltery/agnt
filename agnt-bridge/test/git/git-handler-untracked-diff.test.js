const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { gitStatus, handleGitRequest } = require("../../src/git/git-handler");
const { git, makeTempRepo } = require("./git-handler-test-helpers");

test("checkout diffs include nested untracked files with literal names from a subdirectory", async () => {
  const repoDir = makeTempRepo();
  try {
    git(repoDir, "update-ref", "refs/remotes/origin/main", "HEAD");
    fs.mkdirSync(path.join(repoDir, "new folder"));
    fs.writeFileSync(path.join(repoDir, "new folder", 'quote" and space.txt'), "first new line\nsecond new line\n");
    fs.writeFileSync(path.join(repoDir, "new folder", "trailing space "), "third new line\n");
    fs.writeFileSync(path.join(repoDir, "new folder", "line\nbreak.txt"), "fourth new line\n");
    const cwd = path.join(repoDir, "agnt-bridge", "src");
    const rootStatus = await gitStatus(repoDir);
    const nestedStatus = await gitStatus(cwd);
    assert.deepEqual(rootStatus.diff, { additions: 4, deletions: 0, binaryFiles: 0 });
    assert.deepEqual(nestedStatus.diff, rootStatus.diff);
    const response = await new Promise((resolve) => handleGitRequest(
      JSON.stringify({ id: 1, method: "git/diff", params: { cwd } }),
      (raw) => resolve(JSON.parse(raw)),
    ));
    assert.equal(response.error, undefined);
    for (const text of ["first new line", "second new line", "third new line", "fourth new line"]) {
      assert.ok(response.result.patch.includes(`+${text}`));
    }
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
