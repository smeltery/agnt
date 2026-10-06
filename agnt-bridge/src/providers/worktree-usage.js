const fs = require("node:fs");
const path = require("node:path");
const { listProviders } = require("./index");

// A deletion must fail closed when another runtime's on-disk catalog cannot be
// verified. Installing a CLI alone does not block cleanup; existing state does.
async function assertInactiveCatalogsEmpty(activeId, providers = listProviders(), fsModule = fs) {
  for (const provider of providers) {
    if (provider.id === activeId) continue;
    const root = provider.id === "opencode" ? provider.homeDir() : provider.sessionsDir();
    try {
      if (fsModule.readdirSync(root).length) {
        throw new Error(`Cannot verify ${provider.displayName} chat usage while that runtime is inactive. Remove this checkout manually after checking its chats.`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function createWorktreeUsageVerifier({ activeProvider, sendRequest, verifyInactive = assertInactiveCatalogsEmpty }) {
  return async function assertUnused(root) {
    const canonical = (value) => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };
    const normalizedRoot = canonical(root);
    await verifyInactive(activeProvider.id);
    for (const archived of [false, true]) {
      const scans = activeProvider.id === "codex" ? [true, false] : [undefined];
      for (const useStateDbOnly of scans) {
        let cursor = null;
        const cursors = new Set();
        do {
          const result = await sendRequest("thread/list", { archived, limit: 200, cursor,
            ...(useStateDbOnly === undefined ? {} : { useStateDbOnly, sourceKinds: ["cli", "vscode", "appServer", "exec", "unknown"], modelProviders: [] }) });
          const rows = result?.data ?? result?.items ?? result?.threads;
          if (!Array.isArray(rows)) throw new Error("The chat catalog could not be verified.");
          for (const row of rows) {
            let cwd = row.cwd || row.directory || row.projectPath;
            if (!cwd) {
              const id = row.id || row.threadId;
              if (!id) throw new Error("A chat has no identifiable folder.");
              const detail = (await sendRequest("thread/read", { threadId: id, includeTurns: false })).thread;
              cwd = detail?.cwd || detail?.directory;
              if (!cwd && !(detail && Object.hasOwn(detail, "cwd") && detail.cwd === null)) throw new Error("A chat has no known folder.");
            }
            if (cwd) {
              const relative = path.relative(normalizedRoot, canonical(cwd));
              if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) throw new Error("Another chat still uses this worktree. Move it to the local checkout before removal.");
            }
          }
          cursor = result.nextCursor ?? result.next_cursor ?? null;
          if (!cursor && result.hasMore === true) throw new Error("The chat catalog is incomplete.");
          if (cursor) {
            const key = JSON.stringify(cursor);
            if (cursors.has(key) || cursors.size >= 1000) throw new Error("The chat catalog could not be completely verified.");
            cursors.add(key);
          }
        } while (cursor);
      }
    }
  };
}

module.exports = { createWorktreeUsageVerifier, assertInactiveCatalogsEmpty };
