// Per-turn revert state. Holds the current preview for the open RevertSheet,
// plus the apply lifecycle (idle → applying → done | error). Checkpoints are
// captured by the bridge automatically per-turn — the web client never calls
// checkpointCapture itself; we only ever preview + apply existing checkpoints.

import { create } from "zustand";
import { makeLogger } from "../lib/log";
import type { JsonRpcClient } from "../protocol/jsonrpc-client";
import {
  applyCheckpointRestore,
  type CheckpointRestorePreview,
  previewCheckpointRestore,
} from "../protocol/workspace-checkpoints";

const log = makeLogger("checkpoints");

export interface RevertTarget {
  threadId: string;
  turnId: string;
  cwd: string;
}

interface State {
  open: boolean;
  target: RevertTarget | null;
  preview: CheckpointRestorePreview | null;
  loading: boolean;
  applying: boolean;
  error: string | null;
  /** Latest restored-files list from a successful apply, surfaced briefly to confirm. */
  appliedFiles: string[] | null;

  show(rpc: JsonRpcClient, target: RevertTarget): Promise<void>;
  apply(rpc: JsonRpcClient): Promise<boolean>;
  hide(): void;
  reset(): void;
}

export const useCheckpointsStore = create<State>((set, get) => ({
  open: false,
  target: null,
  preview: null,
  loading: false,
  applying: false,
  error: null,
  appliedFiles: null,

  async show(rpc, target) {
    set({
      open: true,
      target,
      preview: null,
      loading: true,
      applying: false,
      error: null,
      appliedFiles: null,
    });
    try {
      const preview = await previewCheckpointRestore(rpc, target);
      set({ preview, loading: false });
    } catch (error) {
      log.warn("checkpoint preview failed", error);
      set({ loading: false, error: errorMessage(error) });
    }
  },

  async apply(rpc) {
    const { target, preview } = get();
    if (!target || !preview) return false;
    set({ applying: true, error: null });
    try {
      const result = await applyCheckpointRestore(rpc, target, { expectedTargetCommit: preview.commit });
      set({
        applying: false,
        appliedFiles: result.restoredFiles,
        // Auto-close on success — caller can show a NoticeStack toast.
        open: result.success ? false : true,
      });
      return result.success;
    } catch (error) {
      log.warn("checkpoint apply failed", error);
      set({ applying: false, error: errorMessage(error) });
      return false;
    }
  },

  hide() {
    set({ open: false });
  },

  reset() {
    set({
      open: false,
      target: null,
      preview: null,
      loading: false,
      applying: false,
      error: null,
      appliedFiles: null,
    });
  },
}));

function errorMessage(error: unknown): string {
  return (error as { userMessage?: string; message?: string })?.userMessage
    ?? (error as Error)?.message
    ?? "Checkpoint operation failed.";
}

export function __resetCheckpointsStoreForTests(): void {
  useCheckpointsStore.getState().reset();
}
