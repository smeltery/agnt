// FILE: workspace-handler.js
// Purpose: Routes workspace-scoped previews, reads, and patch operations without touching unrelated repo changes.
// Layer: Bridge handler
// Exports: handleWorkspaceRequest

const { createJsonRpcRequestHandler } = require("./handler-utils");
const {
  workspaceCheckpointCapture,
  workspaceCheckpointCopy,
  workspaceCheckpointDiff,
  workspaceCheckpointRestoreApply,
  workspaceCheckpointRestorePreview,
} = require("./workspace-checkpoints");
const { workspaceReadFile } = require("./workspace-read-file");
const { workspaceReadImage } = require("./workspace-read-image");
const {
  workspaceRevertPatchApply,
  workspaceRevertPatchBatchApply,
  workspaceRevertPatchBatchPreview,
  workspaceRevertPatchPreview,
} = require("./workspace-revert-patch");
const {
  resolveRepoRoot,
  resolveWorkspaceCwd,
  workspaceError,
} = require("./workspace-paths");

const repoMutationLocks = new Map();

const handleWorkspaceRequest = createJsonRpcRequestHandler({
  match: (method) => method.startsWith("workspace/"),
  dispatch: handleWorkspaceMethod,
  defaultErrorCode: "workspace_error",
  defaultErrorMessage: "Unknown workspace error",
});

async function handleWorkspaceMethod(method, params, options = {}) {
  if (method === "workspace/readImage") {
    return workspaceReadImage(params, options);
  }
  if (method === "workspace/readFile") {
    return workspaceReadFile(params);
  }

  const cwd = await resolveWorkspaceCwd(params);
  const repoRoot = await resolveRepoRoot(cwd);

  switch (method) {
    case "workspace/checkpointCapture":
      return withRepoMutationLock(repoRoot, () => workspaceCheckpointCapture(repoRoot, params));
    case "workspace/checkpointCopy":
      return withRepoMutationLock(repoRoot, () => workspaceCheckpointCopy(repoRoot, params));
    case "workspace/checkpointDiff":
      return workspaceCheckpointDiff(repoRoot, params);
    case "workspace/checkpointRestorePreview":
      return workspaceCheckpointRestorePreview(repoRoot, params);
    case "workspace/checkpointRestoreApply":
      return withRepoMutationLock(repoRoot, () => workspaceCheckpointRestoreApply(repoRoot, params));
    case "workspace/revertPatchPreview":
      return workspaceRevertPatchPreview(repoRoot, params);
    case "workspace/revertPatchApply":
      return withRepoMutationLock(repoRoot, () => workspaceRevertPatchApply(repoRoot, params));
    case "workspace/revertPatchBatchPreview":
      return workspaceRevertPatchBatchPreview(repoRoot, params);
    case "workspace/revertPatchBatchApply":
      return withRepoMutationLock(repoRoot, () => workspaceRevertPatchBatchApply(repoRoot, params));
    default:
      throw workspaceError("unknown_method", `Unknown workspace method: ${method}`);
  }
}

async function withRepoMutationLock(cwd, callback) {
  const previous = repoMutationLocks.get(cwd) || Promise.resolve();
  let releaseCurrent = null;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const chained = previous.then(() => current);
  repoMutationLocks.set(cwd, chained);

  await previous;
  try {
    return await callback();
  } finally {
    releaseCurrent();
    if (repoMutationLocks.get(cwd) === chained) {
      repoMutationLocks.delete(cwd);
    }
  }
}

module.exports = { handleWorkspaceMethod, handleWorkspaceRequest };
