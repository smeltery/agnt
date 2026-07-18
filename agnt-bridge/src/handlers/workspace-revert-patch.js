// FILE: workspace-revert-patch.js
// Purpose: Safely previews and applies reverse patches for workspace-scoped edits.
// Layer: Bridge handler helper
// Exports: workspaceRevertPatchApply, workspaceRevertPatchBatchApply, workspaceRevertPatchBatchPreview, workspaceRevertPatchPreview
// Depends on: child_process, fs, os, path, ../git/git-handler

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const { gitStatus } = require("../git/git-handler");
const { analyzeUnifiedPatch } = require("./workspace-revert-patch-analysis");

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const GIT_EXEC_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

async function workspaceRevertPatchPreview(repoRoot, params) {
  const forwardPatch = resolveForwardPatch(params);
  const analysis = analyzeUnifiedPatch(forwardPatch);
  const stagedFiles = await findStagedTargetedFiles(repoRoot, analysis.affectedFiles);

  if (analysis.unsupportedReasons.length || stagedFiles.length) {
    return {
      canRevert: false,
      affectedFiles: analysis.affectedFiles,
      conflicts: [],
      unsupportedReasons: analysis.unsupportedReasons,
      stagedFiles,
    };
  }

  const applyCheck = await checkReversePatch(repoRoot, forwardPatch);
  const conflicts = applyCheck.ok
    ? []
    : parseApplyConflicts(applyCheck.stderr || applyCheck.stdout || "Patch does not apply.");

  return {
    canRevert: applyCheck.ok && conflicts.length === 0,
    affectedFiles: analysis.affectedFiles,
    conflicts,
    unsupportedReasons: [],
    stagedFiles,
  };
}

async function workspaceRevertPatchApply(repoRoot, params) {
  const forwardPatch = resolveForwardPatch(params);
  const preview = await workspaceRevertPatchPreview(repoRoot, params);
  if (!preview.canRevert) {
    return {
      success: false,
      revertedFiles: [],
      conflicts: preview.conflicts,
      unsupportedReasons: preview.unsupportedReasons,
      stagedFiles: preview.stagedFiles,
    };
  }

  const checkedPatch = await checkReversePatch(repoRoot, forwardPatch);
  const applyResult = checkedPatch.ok
    ? await runGitApply(repoRoot, checkedPatch.applyArgs, forwardPatch)
    : checkedPatch;
  if (!applyResult.ok) {
    return {
      success: false,
      revertedFiles: [],
      conflicts: parseApplyConflicts(applyResult.stderr || applyResult.stdout || "Patch does not apply."),
      unsupportedReasons: [],
      stagedFiles: [],
      status: await gitStatus(repoRoot).catch(() => null),
    };
  }

  await resetTargetedFilesIndex(repoRoot, preview.affectedFiles);
  const status = await gitStatus(repoRoot).catch(() => null);
  return {
    success: true,
    revertedFiles: preview.affectedFiles,
    conflicts: [],
    unsupportedReasons: [],
    stagedFiles: [],
    status,
  };
}

async function workspaceRevertPatchBatchPreview(repoRoot, params) {
  const patches = resolveForwardPatchBatch(params);
  const analyses = patches.map((patch) => analyzeUnifiedPatch(patch.forwardPatch));
  const affectedFiles = uniqueSorted(analyses.flatMap((analysis) => analysis.affectedFiles));
  const unsupportedReasons = uniqueSorted(analyses.flatMap((analysis) => analysis.unsupportedReasons));
  const stagedFiles = await findStagedTargetedFiles(repoRoot, affectedFiles);

  if (unsupportedReasons.length || stagedFiles.length) {
    return {
      canRevert: false,
      affectedFiles,
      conflicts: [],
      unsupportedReasons,
      stagedFiles,
      patchResults: patches.map((patch, index) => ({
        id: patch.id,
        canRevert: analyses[index].unsupportedReasons.length === 0,
        unsupportedReasons: analyses[index].unsupportedReasons,
      })),
    };
  }

  const sequenceCheck = await previewReversePatchSequence(repoRoot, patches, affectedFiles);
  const conflicts = sequenceCheck.ok
    ? []
    : parseApplyConflicts(sequenceCheck.stderr || sequenceCheck.stdout || "Patch batch does not apply.");

  return {
    canRevert: sequenceCheck.ok && conflicts.length === 0,
    affectedFiles,
    conflicts,
    unsupportedReasons: [],
    stagedFiles,
    patchResults: patches.map((patch) => ({
      id: patch.id,
      canRevert: sequenceCheck.ok && conflicts.length === 0,
    })),
  };
}

async function workspaceRevertPatchBatchApply(repoRoot, params) {
  const patches = resolveForwardPatchBatch(params);
  const preview = await workspaceRevertPatchBatchPreview(repoRoot, params);
  if (!preview.canRevert) {
    return {
      success: false,
      revertedFiles: [],
      conflicts: preview.conflicts,
      unsupportedReasons: preview.unsupportedReasons,
      stagedFiles: preview.stagedFiles,
      patchResults: preview.patchResults || [],
    };
  }

  const applyResult = await applyReversePatchSequence(repoRoot, patches, preview.affectedFiles);
  if (!applyResult.ok) {
    return {
      success: false,
      revertedFiles: [],
      conflicts: parseApplyConflicts(applyResult.stderr || applyResult.stdout || "Patch batch does not apply."),
      unsupportedReasons: [],
      stagedFiles: [],
      patchResults: patches.map((patch) => ({
        id: patch.id,
        applied: applyResult.appliedPatchIds.includes(patch.id),
      })),
      status: await gitStatus(repoRoot).catch(() => null),
    };
  }

  await resetTargetedFilesIndex(repoRoot, preview.affectedFiles);
  const status = await gitStatus(repoRoot).catch(() => null);
  return {
    success: true,
    revertedFiles: preview.affectedFiles,
    conflicts: [],
    unsupportedReasons: [],
    stagedFiles: [],
    patchResults: patches.map((patch) => ({ id: patch.id, applied: true })),
    status,
  };
}

function resolveForwardPatch(params) {
  const forwardPatch =
    typeof params.forwardPatch === "string" ? params.forwardPatch : "";

  if (!forwardPatch.trim()) {
    throw workspaceError("missing_patch", "The request must include a non-empty forwardPatch.");
  }

  return forwardPatch.endsWith("\n") ? forwardPatch : `${forwardPatch}\n`;
}

function resolveForwardPatchBatch(params) {
  const rawPatches = Array.isArray(params.patches) ? params.patches : [];
  const patches = rawPatches.map((rawPatch, index) => {
    if (typeof rawPatch === "string") {
      return {
        id: String(index),
        forwardPatch: rawPatch.endsWith("\n") ? rawPatch : `${rawPatch}\n`,
      };
    }

    const forwardPatch = rawPatch && typeof rawPatch.forwardPatch === "string"
      ? rawPatch.forwardPatch
      : "";
    return {
      id: rawPatch && typeof rawPatch.id === "string" ? rawPatch.id : String(index),
      forwardPatch: forwardPatch.endsWith("\n") ? forwardPatch : `${forwardPatch}\n`,
    };
  }).filter((patch) => patch.forwardPatch.trim());

  if (!patches.length) {
    throw workspaceError("missing_patch", "The request must include at least one non-empty patch.");
  }

  return patches;
}

async function findStagedTargetedFiles(cwd, affectedFiles) {
  if (!affectedFiles.length) {
    return [];
  }

  try {
    const output = await git(cwd, "diff", "--name-only", "--cached", "--", ...affectedFiles);
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

async function previewReversePatchSequence(repoRoot, patches, affectedFiles) {
  const sandboxRoot = await createPatchSandbox(repoRoot, affectedFiles);

  try {
    for (const patch of patches) {
      const check = await checkReversePatch(sandboxRoot, patch.forwardPatch);
      if (!check.ok) {
        return { ...check, failedPatchId: patch.id };
      }

      const applied = await runGitApply(sandboxRoot, check.applyArgs, patch.forwardPatch);
      if (!applied.ok) {
        return { ...applied, failedPatchId: patch.id };
      }
      await syncPatchSandboxIndex(sandboxRoot);
    }

    return { ok: true, stdout: "", stderr: "" };
  } finally {
    await fs.promises.rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function applyReversePatchSequence(repoRoot, patches, affectedFiles) {
  const appliedPatchIds = [];
  const backup = await createPatchBackup(repoRoot, affectedFiles);

  try {
    for (const patch of patches) {
      const checkedPatch = await checkReversePatch(repoRoot, patch.forwardPatch);
      if (!checkedPatch.ok) {
        await restorePatchBackup(repoRoot, backup);
        return { ...checkedPatch, appliedPatchIds, failedPatchId: patch.id };
      }

      const appliedPatch = await runGitApply(repoRoot, checkedPatch.applyArgs, patch.forwardPatch);
      if (!appliedPatch.ok) {
        await restorePatchBackup(repoRoot, backup);
        return { ...appliedPatch, appliedPatchIds, failedPatchId: patch.id };
      }

      appliedPatchIds.push(patch.id);
    }

    return { ok: true, stdout: "", stderr: "", appliedPatchIds };
  } finally {
    await fs.promises.rm(backup.root, { recursive: true, force: true }).catch(() => {});
  }
}

async function createPatchSandbox(repoRoot, affectedFiles) {
  const sandboxRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agnt-revert-preview-"));

  for (const affectedFile of affectedFiles) {
    const sourcePath = path.resolve(repoRoot, affectedFile);
    if (!isPathInside(sourcePath, repoRoot)) {
      continue;
    }

    const destinationPath = path.resolve(sandboxRoot, affectedFile);
    if (!isPathInside(destinationPath, sandboxRoot) || !fs.existsSync(sourcePath)) {
      continue;
    }

    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.promises.copyFile(sourcePath, destinationPath);
  }

  await initializePatchSandboxGitRepo(sandboxRoot);
  return sandboxRoot;
}

async function initializePatchSandboxGitRepo(sandboxRoot) {
  await git(sandboxRoot, "init", "-q");
  await git(sandboxRoot, "config", "user.email", "agnt@example.local");
  await git(sandboxRoot, "config", "user.name", "Agnt");
  await syncPatchSandboxIndex(sandboxRoot);
  await git(sandboxRoot, "commit", "-qm", "snapshot", "--allow-empty");
}

async function syncPatchSandboxIndex(sandboxRoot) {
  await git(sandboxRoot, "add", "-A");
}

async function createPatchBackup(repoRoot, affectedFiles) {
  const backupRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agnt-revert-backup-"));
  const entries = [];

  for (const affectedFile of affectedFiles) {
    const sourcePath = path.resolve(repoRoot, affectedFile);
    if (!isPathInside(sourcePath, repoRoot)) {
      continue;
    }

    const backupPath = path.resolve(backupRoot, affectedFile);
    if (!isPathInside(backupPath, backupRoot)) {
      continue;
    }

    const exists = fs.existsSync(sourcePath);
    entries.push({ relativePath: affectedFile, exists });
    if (!exists) {
      continue;
    }

    await fs.promises.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.promises.copyFile(sourcePath, backupPath);
  }

  return { root: backupRoot, entries };
}

async function restorePatchBackup(repoRoot, backup) {
  for (const entry of backup.entries) {
    const targetPath = path.resolve(repoRoot, entry.relativePath);
    if (!isPathInside(targetPath, repoRoot)) {
      continue;
    }

    if (!entry.exists) {
      await fs.promises.rm(targetPath, { force: true, recursive: true }).catch(() => {});
      continue;
    }

    const backupPath = path.resolve(backup.root, entry.relativePath);
    if (!isPathInside(backupPath, backup.root)) {
      continue;
    }

    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.copyFile(backupPath, targetPath);
  }

  await resetTargetedFilesIndex(repoRoot, backup.entries.map((entry) => entry.relativePath));
}

async function resetTargetedFilesIndex(cwd, affectedFiles) {
  if (!affectedFiles.length) {
    return;
  }

  await git(cwd, "reset", "-q", "--", ...affectedFiles);
}

async function checkReversePatch(cwd, patchText) {
  if (isFileLifecyclePatch(patchText)) {
    const plainCheck = await runGitApply(cwd, ["apply", "--reverse", "--check"], patchText);
    return { ...plainCheck, applyArgs: ["apply", "--reverse"] };
  }

  const codexCheckArgs = ["apply", "--reverse", "--check", "--3way"];
  const plainCheckArgs = ["apply", "--reverse", "--check"];
  const codexCheck = await runGitApply(cwd, codexCheckArgs, patchText);

  if (codexCheck.ok) {
    return { ...codexCheck, applyArgs: ["apply", "--reverse", "--3way"] };
  }

  if (!isIndexMismatch(codexCheck)) {
    return { ...codexCheck, applyArgs: ["apply", "--reverse", "--3way"] };
  }

  const plainCheck = await runGitApply(cwd, plainCheckArgs, patchText);
  return { ...plainCheck, applyArgs: ["apply", "--reverse"] };
}

function isFileLifecyclePatch(patchText) {
  return String(patchText || "")
    .split("\n")
    .some((line) => line === "--- /dev/null" || line === "+++ /dev/null");
}

function isIndexMismatch(result) {
  const output = `${result.stderr || ""}\n${result.stdout || ""}`;
  return output.includes("does not match index");
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

async function runGitApply(cwd, args, patchText) {
  const tempPatchPath = await writeTempPatchFile(patchText);

  try {
    const { stdout, stderr } = await execFileAsync("git", [...args, tempPatchPath], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_EXEC_MAX_BUFFER_BYTES,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || "",
    };
  } finally {
    try {
      fs.unlinkSync(tempPatchPath);
    } catch {
      // Ignore temp cleanup failures.
    }
  }
}

async function writeTempPatchFile(patchText) {
  const tempPatchPath = path.join(
    os.tmpdir(),
    `agnt-revert-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`
  );
  await fs.promises.writeFile(tempPatchPath, patchText, "utf8");
  return tempPatchPath;
}

function parseApplyConflicts(stderr) {
  const lines = String(stderr || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const conflictsByPath = new Map();
  for (const line of lines) {
    let conflictPath = "unknown";
    const patchFailedMatch = line.match(/^error:\s+patch failed:\s+(.+?):\d+$/i);
    const doesNotApplyMatch = line.match(/^error:\s+(.+?):\s+patch does not apply$/i);

    if (patchFailedMatch) {
      conflictPath = patchFailedMatch[1];
    } else if (doesNotApplyMatch) {
      conflictPath = doesNotApplyMatch[1];
    }

    if (!conflictsByPath.has(conflictPath)) {
      conflictsByPath.set(conflictPath, { path: conflictPath, message: line });
    }
  }

  if (!conflictsByPath.size && lines.length) {
    return [{ path: "unknown", message: lines.join(" ") }];
  }

  return [...conflictsByPath.values()];
}

function isPathInside(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function workspaceError(errorCode, userMessage) {
  const err = new Error(userMessage);
  err.errorCode = errorCode;
  err.userMessage = userMessage;
  return err;
}

function git(cwd, ...args) {
  return execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_EXEC_MAX_BUFFER_BYTES,
  })
    .then(({ stdout }) => stdout)
    .catch((err) => {
      const msg = (err.stderr || err.message || "").trim();
      throw new Error(msg || "git command failed");
    });
}

module.exports = {
  workspaceRevertPatchApply,
  workspaceRevertPatchBatchApply,
  workspaceRevertPatchBatchPreview,
  workspaceRevertPatchPreview,
};
