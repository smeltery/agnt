// FILE: diff-helpers.js
// Purpose: All things "compute a diff or numstat" for the bridge —
//          tracked vs base ref, untracked files vs /dev/null, the
//          parser that turns `git diff --numstat` output into totals.
//          Used by gitStatus, gitDiff, the AI-draft context builders,
//          and the worktree-handoff state machine.
// Layer: bridge utility — factory takes the few git primitives it
//        needs as deps so this module has no implicit coupling back
//        to git-handler.js's other internals.
// Exports: createDiffHelpers (factory), parseNumstatTotals (pure).
//
// Why a module: git-handler.js used to inline 10 diff/numstat helpers
// across ~150 lines, interleaved with worktree orchestration and
// repo-root resolution. They form a coherent unit — every helper here
// either runs `git diff` or summarises its output — so lifting them
// gives git-handler.js back a more focused surface and lets the parser
// be unit-tested in isolation.

const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
// Node defaults maxBuffer to 1 MiB; large repo diffs trip "stdout maxBuffer length exceeded".
const GIT_EXEC_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

// git's well-known empty-tree SHA-1. Used as the base ref when HEAD does
// not yet exist (fresh repo, before any commit).
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * @param {object} deps
 * @param {(cwd: string, ...args: string[]) => Promise<string>} deps.git
 *   — git-handler's shell-out wrapper. Used for everything except
 *     `diff --no-index`, which has its own non-zero-exit semantics and
 *     is invoked directly via execFileAsync below.
 * @param {(cwd: string, refName: string) => Promise<boolean>} deps.refExists
 *   — used by resolveRepoDiffBase to decide whether HEAD or the empty
 *     tree is the right base for the very first commit.
 * @returns {{
 *   repoDiffTotals: Function,
 *   resolveRepoDiffBase: Function,
 *   diffTotalsAgainstBase: Function,
 *   gitDiffAgainstBase: Function,
 *   diffTotalsForUntrackedFiles: Function,
 *   countLocalOnlyCommits: Function,
 *   diffPatchForUntrackedFiles: Function,
 * }}
 */
function createDiffHelpers({ git, refExists }) {
  // ── totals API ─────────────────────────────────────────────────────────

  async function repoDiffTotals(cwd, context) {
    const baseRef = await resolveRepoDiffBase(cwd, context.tracking);
    const trackedTotals = await diffTotalsAgainstBase(cwd, baseRef);
    const untrackedPaths = context.fileLines
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.substring(3).trim())
      .filter(Boolean);
    const untrackedTotals = await diffTotalsForUntrackedFiles(cwd, untrackedPaths);

    return {
      additions: trackedTotals.additions + untrackedTotals.additions,
      deletions: trackedTotals.deletions + untrackedTotals.deletions,
      binaryFiles: trackedTotals.binaryFiles + untrackedTotals.binaryFiles,
    };
  }

  // Uses upstream when available; otherwise falls back to commits not yet
  // present on any remote.
  async function resolveRepoDiffBase(cwd, tracking) {
    if (!(await refExists(cwd, "HEAD"))) {
      return EMPTY_TREE_HASH;
    }

    if (tracking) {
      try {
        return (await git(cwd, "merge-base", "HEAD", "@{u}")).trim();
      } catch {
        // Fall through to the local-only commit scan if upstream metadata is stale.
      }
    }

    const firstLocalOnlyCommit = (
      await git(cwd, "rev-list", "--reverse", "--topo-order", "HEAD", "--not", "--remotes")
    )
      .trim()
      .split("\n")
      .find(Boolean);

    if (!firstLocalOnlyCommit) {
      return "HEAD";
    }

    try {
      return (await git(cwd, "rev-parse", `${firstLocalOnlyCommit}^`)).trim();
    } catch {
      return EMPTY_TREE_HASH;
    }
  }

  async function diffTotalsAgainstBase(cwd, baseRef) {
    const output = await git(cwd, "diff", "--numstat", baseRef);
    return parseNumstatTotals(output);
  }

  async function gitDiffAgainstBase(cwd, baseRef) {
    return git(cwd, "diff", "--binary", "--find-renames", baseRef);
  }

  async function diffTotalsForUntrackedFiles(cwd, filePaths) {
    if (!filePaths.length) {
      return { additions: 0, deletions: 0, binaryFiles: 0 };
    }

    const totals = await Promise.all(
      filePaths.map(async (filePath) => {
        const output = await gitDiffNoIndexNumstat(cwd, filePath);
        return parseNumstatTotals(output);
      })
    );

    return totals.reduce(
      (aggregate, current) => ({
        additions: aggregate.additions + current.additions,
        deletions: aggregate.deletions + current.deletions,
        binaryFiles: aggregate.binaryFiles + current.binaryFiles,
      }),
      { additions: 0, deletions: 0, binaryFiles: 0 }
    );
  }

  // Counts commits reachable from HEAD that are not present on any remote
  // ref. Returns 0 quickly when there are no remote refs at all (e.g. a
  // local-only repo) so we don't surface a misleading "ahead by N" number.
  async function countLocalOnlyCommits(cwd, context) {
    if (context.detached) {
      return 0;
    }

    const remoteRefs = await git(cwd, "for-each-ref", "--format=%(refname)", "refs/remotes");
    const hasAnyRemoteRefs = remoteRefs
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .length > 0;

    if (!hasAnyRemoteRefs) {
      return 0;
    }

    const output = await git(cwd, "rev-list", "--count", "HEAD", "--not", "--remotes");
    return Number.parseInt(output.trim(), 10) || 0;
  }

  // ── patch API ──────────────────────────────────────────────────────────

  async function diffPatchForUntrackedFiles(cwd, filePaths) {
    if (!filePaths.length) {
      return "";
    }

    const patches = await Promise.all(filePaths.map((filePath) => gitDiffNoIndexPatch(cwd, filePath)));
    return patches.filter(Boolean).join("\n\n");
  }

  return {
    countLocalOnlyCommits,
    diffPatchForUntrackedFiles,
    diffTotalsAgainstBase,
    diffTotalsForUntrackedFiles,
    gitDiffAgainstBase,
    repoDiffTotals,
    resolveRepoDiffBase,
  };
}

// ── private execFileAsync-based helpers ───────────────────────────────────
//
// `git diff --no-index` returns exit code 1 when files differ — that's the
// success case for us, not a failure. We shell out directly here instead
// of going through `git()` so we can intercept code 1 without losing the
// stdout payload. These two helpers are defined at module scope so the
// factory's closure can use them without holding extra references.

async function gitDiffNoIndexNumstat(cwd, filePath) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--no-index", "--numstat", "--", "/dev/null", filePath],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_EXEC_MAX_BUFFER_BYTES }
    );
    return stdout;
  } catch (err) {
    if (typeof err?.code === "number" && err.code === 1) {
      return err.stdout || "";
    }
    const msg = (err.stderr || err.message || "").trim();
    throw new Error(msg || "git diff --no-index failed");
  }
}

async function gitDiffNoIndexPatch(cwd, filePath) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--no-index", "--binary", "--", "/dev/null", filePath],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_EXEC_MAX_BUFFER_BYTES }
    );
    return stdout;
  } catch (err) {
    if (typeof err?.code === "number" && err.code === 1) {
      return err.stdout || "";
    }
    const msg = (err.stderr || err.message || "").trim();
    throw new Error(msg || "git diff --no-index failed");
  }
}

// ── pure helper (no factory needed) ──────────────────────────────────────

// Parses `git diff --numstat` output into {additions, deletions, binaryFiles}.
// Binary files show "-\t-\t<path>" in numstat; we count them separately so
// the bridge can report "12 added · 3 deleted · 2 binary" without lying.
function parseNumstatTotals(output) {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .reduce(
      (aggregate, line) => {
        const [rawAdditions, rawDeletions] = line.split("\t");
        const additions = Number.parseInt(rawAdditions, 10);
        const deletions = Number.parseInt(rawDeletions, 10);
        const isBinary = !Number.isFinite(additions) || !Number.isFinite(deletions);

        return {
          additions: aggregate.additions + (Number.isFinite(additions) ? additions : 0),
          deletions: aggregate.deletions + (Number.isFinite(deletions) ? deletions : 0),
          binaryFiles: aggregate.binaryFiles + (isBinary ? 1 : 0),
        };
      },
      { additions: 0, deletions: 0, binaryFiles: 0 }
    );
}

module.exports = {
  EMPTY_TREE_HASH,
  createDiffHelpers,
  parseNumstatTotals,
};
