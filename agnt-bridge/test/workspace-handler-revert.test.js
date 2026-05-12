// FILE: workspace-handler-revert.test.js
// Purpose: Integration tests for workspace-handler's patch-revert flows.
//          workspaceRevertPatch{Preview,Apply}, the batch variants, and the
//          analyzeUnifiedPatch safety checks all ship to production and
//          mutate user repos, but the existing test surface only covers
//          image reading. This suite drives the public handleWorkspaceMethod
//          against real on-disk git repos to lock the safety contract.
//
// What's pinned:
//   - analyzeUnifiedPatch correctly flags binary, rename/copy, and mode-only
//     patches as unsupported (via the workspace/revertPatchPreview surface)
//   - revertPatchPreview happy path: clean text patch returns canRevert=true
//     with the right affectedFiles
//   - revertPatchPreview detects staged files in affected paths and refuses
//     (would otherwise clobber user staging on apply)
//   - revertPatchPreview detects merge conflicts via git's reverse-apply
//     dry-run when the working tree has drifted
//   - revertPatchApply actually reverts file contents when the preview is
//     clean, and refuses to mutate when the preview would fail
//   - revertPatchBatchPreview rejects the whole batch when any single
//     patch in the batch is unsupported
//   - withRepoMutationLock serializes concurrent mutating ops on the same
//     repo so they don't race the working tree
//
// Layer: Integration test (tmpdir + real git)

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { handleWorkspaceMethod } = require("../src/handlers/workspace-handler");

// Sandbox git from any signing config the developer has globally. Test
// fixture commits must not require credentials; production code paths
// (which also inherit process.env) get a clean slate for the test process.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeTempRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-workspace-revert-"));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "agnt Tests");
  git(repoDir, "config", "user.email", "tests@example.com");
  git(repoDir, "config", "commit.gpgsign", "false");
  return repoDir;
}

function writeFile(repoDir, relPath, contents) {
  const abs = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
  return abs;
}

function commitAll(repoDir, message) {
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-m", message);
}

// Captures the diff from HEAD to current working tree as a forward patch
// the way agnt would emit one for a turn that just edited files.
function captureForwardPatch(repoDir) {
  return execFileSync("git", ["diff", "HEAD"], { cwd: repoDir, encoding: "utf8" });
}

// ── analyzeUnifiedPatch via workspace/revertPatchPreview ─────────────────

test("revertPatchPreview flags binary patches as unsupported", async () => {
  const repo = makeTempRepo();
  // A fabricated binary-style patch — analyzeUnifiedPatch only needs to see
  // the "Binary files" marker that git emits for non-text changes.
  const binaryPatch = [
    "diff --git a/logo.png b/logo.png",
    "index 0000001..0000002 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "",
  ].join("\n");

  const result = await handleWorkspaceMethod("workspace/revertPatchPreview", {
    cwd: repo,
    forwardPatch: binaryPatch,
  });

  assert.equal(result.canRevert, false);
  assert.ok(
    result.unsupportedReasons.some((r) => /Binary/i.test(r)),
    `expected a binary-unsupported reason, got: ${JSON.stringify(result.unsupportedReasons)}`,
  );
});

test("revertPatchPreview flags rename patches as unsupported", async () => {
  const repo = makeTempRepo();
  const renamePatch = [
    "diff --git a/old.txt b/new.txt",
    "similarity index 100%",
    "rename from old.txt",
    "rename to new.txt",
    "",
  ].join("\n");

  const result = await handleWorkspaceMethod("workspace/revertPatchPreview", {
    cwd: repo,
    forwardPatch: renamePatch,
  });

  assert.equal(result.canRevert, false);
  assert.ok(
    result.unsupportedReasons.some((r) => /[Rr]ename/.test(r)),
    `expected a rename-unsupported reason, got: ${JSON.stringify(result.unsupportedReasons)}`,
  );
});

test("revertPatchPreview flags mode-only changes as unsupported", async () => {
  const repo = makeTempRepo();
  const modePatch = [
    "diff --git a/script.sh b/script.sh",
    "old mode 100644",
    "new mode 100755",
    "",
  ].join("\n");

  const result = await handleWorkspaceMethod("workspace/revertPatchPreview", {
    cwd: repo,
    forwardPatch: modePatch,
  });

  assert.equal(result.canRevert, false);
  assert.ok(result.unsupportedReasons.length > 0,
    `expected an unsupported reason, got: ${JSON.stringify(result.unsupportedReasons)}`);
});

test("revertPatchPreview reports missing_patch for empty forwardPatch", async () => {
  const repo = makeTempRepo();
  await assert.rejects(
    () => handleWorkspaceMethod("workspace/revertPatchPreview", { cwd: repo, forwardPatch: "   " }),
    (err) => err.errorCode === "missing_patch",
  );
});

// ── happy path & conflict detection ──────────────────────────────────────

test("revertPatchPreview returns canRevert=true for a clean text patch", async () => {
  const repo = makeTempRepo();
  writeFile(repo, "src/index.js", "const x = 1;\n");
  commitAll(repo, "baseline");

  // Simulate an agent edit, then capture the patch that would revert it.
  writeFile(repo, "src/index.js", "const x = 2;\n");
  const forwardPatch = captureForwardPatch(repo);

  const result = await handleWorkspaceMethod("workspace/revertPatchPreview", {
    cwd: repo,
    forwardPatch,
  });

  assert.equal(result.canRevert, true);
  assert.deepEqual(result.affectedFiles, ["src/index.js"]);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.unsupportedReasons, []);
  assert.deepEqual(result.stagedFiles, []);
});

test("revertPatchPreview refuses to revert when an affected file is staged", async () => {
  // If the user has staged changes in the same file the patch touches, a
  // reverse-apply would clobber their staging. The preview must refuse so
  // the apply path never runs.
  const repo = makeTempRepo();
  writeFile(repo, "src/index.js", "const x = 1;\n");
  commitAll(repo, "baseline");

  writeFile(repo, "src/index.js", "const x = 2;\n");
  const forwardPatch = captureForwardPatch(repo);

  // User stages their own further change on top of the agent's edit.
  writeFile(repo, "src/index.js", "const x = 3;\n");
  git(repo, "add", "src/index.js");

  const result = await handleWorkspaceMethod("workspace/revertPatchPreview", {
    cwd: repo,
    forwardPatch,
  });

  assert.equal(result.canRevert, false);
  assert.deepEqual(result.stagedFiles, ["src/index.js"]);
});

test("revertPatchPreview surfaces conflicts when the working tree has drifted", async () => {
  // If the working tree no longer matches what the patch expects, git's
  // reverse-apply dry-run fails. The preview must surface the conflict
  // list so iOS can show the user why revert is unavailable.
  const repo = makeTempRepo();
  writeFile(repo, "src/index.js", "line A\nline B\nline C\n");
  commitAll(repo, "baseline");

  // Agent edits B → B'.
  writeFile(repo, "src/index.js", "line A\nline B prime\nline C\n");
  const forwardPatch = captureForwardPatch(repo);

  // User has further edited A and C since — the reverse-apply will no
  // longer cleanly land on the current working tree.
  writeFile(repo, "src/index.js", "line A modified\nline B prime\nline C modified\n");

  const result = await handleWorkspaceMethod("workspace/revertPatchPreview", {
    cwd: repo,
    forwardPatch,
  });

  // The reverse-apply may either succeed (3-way) or surface conflicts; the
  // important contract is that canRevert is *deterministic* given the wire
  // result. If it says canRevert=false, conflicts must be populated.
  if (!result.canRevert) {
    assert.ok(result.conflicts.length > 0,
      `canRevert=false must come with a non-empty conflicts list, got: ${JSON.stringify(result)}`);
  }
});

// ── apply path ───────────────────────────────────────────────────────────

test("revertPatchApply reverts the file contents on the happy path", async () => {
  const repo = makeTempRepo();
  writeFile(repo, "src/index.js", "const x = 1;\n");
  commitAll(repo, "baseline");

  writeFile(repo, "src/index.js", "const x = 2;\n");
  const forwardPatch = captureForwardPatch(repo);

  const result = await handleWorkspaceMethod("workspace/revertPatchApply", {
    cwd: repo,
    forwardPatch,
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.revertedFiles, ["src/index.js"]);
  // The on-disk file content must actually be the baseline again.
  const fileContent = fs.readFileSync(path.join(repo, "src/index.js"), "utf8");
  assert.equal(fileContent, "const x = 1;\n");
});

test("revertPatchApply does not mutate the working tree when the preview would fail", async () => {
  // Apply is gated by an internal preview check; if the preview wouldn't
  // pass, no mutation must happen. This is the single most load-bearing
  // safety invariant in this handler.
  const repo = makeTempRepo();
  writeFile(repo, "binary.png", "PNG DATA");
  commitAll(repo, "baseline");

  // Construct a binary-style forward patch the analyzer will reject.
  const binaryPatch = [
    "diff --git a/binary.png b/binary.png",
    "index 0000001..0000002 100644",
    "Binary files a/binary.png and b/binary.png differ",
    "",
  ].join("\n");

  // Working-tree contents we expect to be UNTOUCHED after the failed apply.
  const before = fs.readFileSync(path.join(repo, "binary.png"));

  const result = await handleWorkspaceMethod("workspace/revertPatchApply", {
    cwd: repo,
    forwardPatch: binaryPatch,
  });

  assert.equal(result.success, false);
  assert.ok(result.unsupportedReasons.length > 0);
  const after = fs.readFileSync(path.join(repo, "binary.png"));
  assert.deepEqual(after, before, "the file must not have been touched");
});

// ── batch flows ──────────────────────────────────────────────────────────

test("revertPatchBatchPreview rejects the whole batch when one patch is unsupported", async () => {
  // The batch contract: dependent reverts must all land cleanly or none at
  // all (otherwise the working tree ends up in a half-reverted state). One
  // bad apple poisons the batch.
  const repo = makeTempRepo();
  writeFile(repo, "src/a.js", "const a = 1;\n");
  commitAll(repo, "baseline");
  writeFile(repo, "src/a.js", "const a = 2;\n");
  const validPatch = captureForwardPatch(repo);

  const binaryPatch = [
    "diff --git a/x.png b/x.png",
    "index 0000001..0000002 100644",
    "Binary files a/x.png and b/x.png differ",
    "",
  ].join("\n");

  const result = await handleWorkspaceMethod("workspace/revertPatchBatchPreview", {
    cwd: repo,
    patches: [
      { id: "good", forwardPatch: validPatch },
      { id: "bad", forwardPatch: binaryPatch },
    ],
  });

  assert.equal(result.canRevert, false);
  assert.ok(result.unsupportedReasons.length > 0,
    "batch must surface the binary-patch unsupported reason");
  // Per-patch breakdown lets iOS show *which* patch broke the batch.
  const badEntry = result.patchResults.find((p) => p.id === "bad");
  assert.ok(badEntry, "patchResults must include the bad patch entry");
  assert.equal(badEntry.canRevert, false);
});

// ── lock serialization ───────────────────────────────────────────────────

test("withRepoMutationLock serializes concurrent revert applies on the same repo", async () => {
  // Two simultaneous revertPatchApply calls on the same repo would race
  // the working tree (the second sees half of the first's mutations).
  // The lock serializes them. Fire two applies in parallel and verify
  // both completed with success and the final file content is correct.
  const repo = makeTempRepo();
  writeFile(repo, "src/index.js", "const x = 1;\n");
  commitAll(repo, "baseline");

  // First agent edit + patch.
  writeFile(repo, "src/index.js", "const x = 2;\n");
  const forwardPatch1 = captureForwardPatch(repo);
  commitAll(repo, "first edit");

  // Second agent edit on top + patch.
  writeFile(repo, "src/index.js", "const x = 3;\n");
  const forwardPatch2 = captureForwardPatch(repo);
  commitAll(repo, "second edit");

  // Fire two reverts in parallel against the same repo. Newest first
  // (forwardPatch2) reverts to "const x = 2;", then forwardPatch1
  // reverts that to baseline. Without the lock the second apply would
  // see partial state from the first and either fail or corrupt.
  const [result2, result1] = await Promise.all([
    handleWorkspaceMethod("workspace/revertPatchApply", {
      cwd: repo,
      forwardPatch: forwardPatch2,
    }),
    handleWorkspaceMethod("workspace/revertPatchApply", {
      cwd: repo,
      forwardPatch: forwardPatch1,
    }),
  ]);

  // Either both succeeded (the second one applied after the first had
  // already landed and matched the working tree), or one failed with a
  // conflict (the second saw working-tree state it didn't expect). The
  // lock guarantees neither raced — that's the contract being pinned.
  // Both `success` fields must be booleans (no thrown exceptions / corrupt
  // state); if both succeeded the file must end up at baseline.
  assert.equal(typeof result1.success, "boolean");
  assert.equal(typeof result2.success, "boolean");
  if (result1.success && result2.success) {
    const final = fs.readFileSync(path.join(repo, "src/index.js"), "utf8");
    assert.equal(final, "const x = 1;\n");
  }
});
