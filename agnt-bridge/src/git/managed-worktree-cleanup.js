const fs = require("node:fs");
const path = require("node:path");
const { managedWorktreesRoot, normalizeExistingPath, sameFilePath } = require("./git-path-helpers");

function createManagedWorktreeCleanup({ git, gitError }) {
  async function registeredWorktrees(cwd) {
    const output = await git(cwd, "worktree", "list", "--porcelain", "-z");
    return output.split("\0\0").flatMap((record) => {
      const fields = record.split("\0");
      const location = fields.find((field) => field.startsWith("worktree "))?.slice(9);
      if (!location) return [];
      return [{ path: location, branch: fields.find((field) => field.startsWith("branch refs/heads/"))?.slice(18) || null }];
    });
  }
  const isManagedLayout = (root) => path.dirname(path.dirname(normalizeExistingPath(root))) === managedWorktreesRoot();
  async function isClean(root) {
    return (await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching")).length === 0;
  }
  async function removeClean(repoRoot, root) {
    if (!isManagedLayout(root)) throw gitError("unmanaged_worktree", "The worktree is outside the managed checkout layout.");
    if (!(await registeredWorktrees(repoRoot)).some((entry) => sameFilePath(entry.path, root))) {
      throw gitError("worktree_not_registered", "This checkout is no longer registered with Git.");
    }
    if (!(await isClean(root))) throw gitError("worktree_not_clean", "This checkout contains changes, untracked files, or ignored files. Preserve them before cleanup.");
    await git(repoRoot, "worktree", "remove", root);
    try { fs.rmdirSync(path.dirname(root)); } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
    }
  }
  async function list(repoRoot) {
    const worktrees = [];
    for (const entry of await registeredWorktrees(repoRoot)) {
      if (isManagedLayout(entry.path)) worktrees.push({ ...entry, isClean: await isClean(entry.path) });
    }
    return { worktrees };
  }
  return { registeredWorktrees, isManagedLayout, isClean, removeClean, list };
}

module.exports = { createManagedWorktreeCleanup };
