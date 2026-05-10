// Workspace checkpoint RPCs. Lets users preview + revert the file changes a
// completed turn made to the bound git repo. Mirrors the surface the bridge
// exposes via workspace-handler.js + workspace-checkpoints.js.
//
// Important: every workspace/* call REQUIRES a `cwd` param. The bridge looks
// up the repo root from there; without it the request errors with
// missing_working_directory. Callers must supply the thread's cwd.

import type { JsonRpcClient } from "./jsonrpc-client";

export interface CheckpointRestorePreview {
  canRestore: boolean;
  repoRoot: string;
  checkpointRef: string;
  commit: string;
  affectedFiles: string[];
  stagedFiles: string[];
  untrackedFiles: string[];
}

export interface CheckpointRestoreResult {
  success: boolean;
  repoRoot: string;
  checkpointRef?: string;
  backupCheckpointRef?: string;
  backupCommit?: string;
  restoredFiles: string[];
}

export interface CheckpointDiff {
  repoRoot: string;
  fromCheckpointRef: string;
  toCheckpointRef: string;
  diff: string;
}

interface CheckpointTarget {
  threadId: string;
  cwd: string;
  turnId?: string;
  messageId?: string;
  /** Default kind is "turnEnd"; override only if the bridge needs a non-default ref. */
  kind?: string;
}

export async function captureCheckpoint(
  rpc: JsonRpcClient,
  target: CheckpointTarget
): Promise<{ checkpointRef: string; commit: string }> {
  const result = await rpc.request<Record<string, unknown>>("workspace/checkpointCapture", {
    threadId: target.threadId,
    turnId: target.turnId,
    messageId: target.messageId,
    kind: target.kind,
    cwd: target.cwd,
  });
  return {
    checkpointRef: stringField(result, "checkpointRef") ?? "",
    commit: stringField(result, "commit") ?? "",
  };
}

export async function previewCheckpointRestore(
  rpc: JsonRpcClient,
  target: CheckpointTarget
): Promise<CheckpointRestorePreview> {
  const result = await rpc.request<Record<string, unknown>>("workspace/checkpointRestorePreview", {
    threadId: target.threadId,
    turnId: target.turnId,
    messageId: target.messageId,
    cwd: target.cwd,
  });
  return decodePreview(result);
}

export async function applyCheckpointRestore(
  rpc: JsonRpcClient,
  target: CheckpointTarget,
  options: { expectedTargetCommit?: string } = {}
): Promise<CheckpointRestoreResult> {
  const result = await rpc.request<Record<string, unknown>>("workspace/checkpointRestoreApply", {
    threadId: target.threadId,
    turnId: target.turnId,
    messageId: target.messageId,
    cwd: target.cwd,
    confirmDestructiveRestore: true,
    expectedTargetCommit: options.expectedTargetCommit,
  });
  return {
    success: Boolean(result.success),
    repoRoot: stringField(result, "repoRoot") ?? "",
    checkpointRef: stringField(result, "checkpointRef"),
    backupCheckpointRef: stringField(result, "backupCheckpointRef"),
    backupCommit: stringField(result, "backupCommit"),
    restoredFiles: stringArrayField(result, "restoredFiles"),
  };
}

export async function checkpointDiff(
  rpc: JsonRpcClient,
  target: CheckpointTarget,
  toTurnId: string
): Promise<CheckpointDiff> {
  const result = await rpc.request<Record<string, unknown>>("workspace/checkpointDiff", {
    threadId: target.threadId,
    fromTurnId: target.turnId,
    toTurnId,
    cwd: target.cwd,
  });
  return {
    repoRoot: stringField(result, "repoRoot") ?? "",
    fromCheckpointRef: stringField(result, "fromCheckpointRef") ?? "",
    toCheckpointRef: stringField(result, "toCheckpointRef") ?? "",
    diff: stringField(result, "diff") ?? "",
  };
}

export function decodePreview(raw: Record<string, unknown>): CheckpointRestorePreview {
  return {
    canRestore: Boolean(raw.canRestore),
    repoRoot: stringField(raw, "repoRoot") ?? "",
    checkpointRef: stringField(raw, "checkpointRef") ?? "",
    commit: stringField(raw, "commit") ?? "",
    affectedFiles: stringArrayField(raw, "affectedFiles"),
    stagedFiles: stringArrayField(raw, "stagedFiles"),
    untrackedFiles: stringArrayField(raw, "untrackedFiles"),
  };
}

// AI Change Sets: per-file revert. Reverse-applies a single file's
// unified diff (the `forwardPatch`) via `git apply -R`. The bridge has
// the same safety checks the per-turn checkpoint flow uses (no staged
// files, no merge conflicts) and returns a structured preview before the
// caller commits to the apply.

export interface RevertPatchPreview {
  canRevert: boolean;
  affectedFiles: string[];
  conflicts: Array<{ file?: string; reason?: string }>;
  unsupportedReasons: string[];
  stagedFiles: string[];
}

export interface RevertPatchResult {
  success: boolean;
  revertedFiles: string[];
  conflicts: Array<{ file?: string; reason?: string }>;
  unsupportedReasons: string[];
  stagedFiles: string[];
}

export async function revertPatchPreview(
  rpc: JsonRpcClient,
  args: { cwd: string; forwardPatch: string }
): Promise<RevertPatchPreview> {
  const raw = await rpc.request<Record<string, unknown>>("workspace/revertPatchPreview", args);
  return decodeRevertPreview(raw ?? {});
}

export async function revertPatchApply(
  rpc: JsonRpcClient,
  args: { cwd: string; forwardPatch: string }
): Promise<RevertPatchResult> {
  const raw = await rpc.request<Record<string, unknown>>("workspace/revertPatchApply", args);
  return {
    success: Boolean(raw?.success),
    revertedFiles: stringArrayField(raw, "revertedFiles"),
    conflicts: decodeConflicts(raw?.conflicts),
    unsupportedReasons: stringArrayField(raw, "unsupportedReasons"),
    stagedFiles: stringArrayField(raw, "stagedFiles"),
  };
}

function decodeRevertPreview(raw: Record<string, unknown>): RevertPatchPreview {
  return {
    canRevert: Boolean(raw.canRevert),
    affectedFiles: stringArrayField(raw, "affectedFiles"),
    conflicts: decodeConflicts(raw.conflicts),
    unsupportedReasons: stringArrayField(raw, "unsupportedReasons"),
    stagedFiles: stringArrayField(raw, "stagedFiles"),
  };
}

function decodeConflicts(raw: unknown): Array<{ file?: string; reason?: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
    .map((entry) => ({
      file: typeof entry.file === "string" ? entry.file : undefined,
      reason: typeof entry.reason === "string" ? entry.reason : undefined,
    }));
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}
