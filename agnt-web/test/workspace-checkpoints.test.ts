import { afterEach, describe, expect, it } from "vitest";
import {
  applyCheckpointRestore,
  decodePreview,
  previewCheckpointRestore,
} from "../src/protocol/workspace-checkpoints";
import type { JsonRpcClient } from "../src/protocol/jsonrpc-client";
import {
  __resetCheckpointsStoreForTests,
  useCheckpointsStore,
} from "../src/state/checkpoints-store";

afterEach(() => __resetCheckpointsStoreForTests());

interface ScriptedCall {
  method: string;
  params: unknown;
}

function fakeRpc(handler: (call: ScriptedCall) => unknown): {
  rpc: JsonRpcClient;
  calls: ScriptedCall[];
} {
  const calls: ScriptedCall[] = [];
  const rpc = {
    request<R>(method: string, params: unknown): Promise<R> {
      const call = { method, params };
      calls.push(call);
      try {
        return Promise.resolve(handler(call) as R);
      } catch (error) {
        return Promise.reject(error);
      }
    },
  } as unknown as JsonRpcClient;
  return { rpc, calls };
}

describe("decodePreview", () => {
  it("decodes a typical bridge preview response", () => {
    const preview = decodePreview({
      canRestore: true,
      repoRoot: "/Users/me/code/agnt",
      checkpointRef: "refs/agnt/checkpoints/thread-x/turnEnd/turn-y",
      commit: "deadbeef00",
      affectedFiles: ["src/a.ts", "src/b.ts"],
      stagedFiles: [],
      untrackedFiles: ["new.txt"],
    });
    expect(preview).toMatchObject({
      canRestore: true,
      commit: "deadbeef00",
      affectedFiles: ["src/a.ts", "src/b.ts"],
      untrackedFiles: ["new.txt"],
    });
  });

  it("filters non-string entries from file arrays", () => {
    const preview = decodePreview({
      canRestore: true,
      affectedFiles: ["ok.ts", 7, null, "ok2.ts"],
      stagedFiles: "not-an-array",
      untrackedFiles: undefined,
    });
    expect(preview.affectedFiles).toEqual(["ok.ts", "ok2.ts"]);
    expect(preview.stagedFiles).toEqual([]);
    expect(preview.untrackedFiles).toEqual([]);
  });

  it("defaults canRestore to false when missing", () => {
    expect(decodePreview({}).canRestore).toBe(false);
  });
});

describe("previewCheckpointRestore", () => {
  it("forwards the cwd + thread + turn identifiers exactly as the bridge expects", async () => {
    const { rpc, calls } = fakeRpc(() => ({
      canRestore: true,
      repoRoot: "/Users/me/repo",
      checkpointRef: "ref",
      commit: "c",
      affectedFiles: [],
    }));
    await previewCheckpointRestore(rpc, {
      threadId: "t1",
      turnId: "u1",
      cwd: "/Users/me/repo",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("workspace/checkpointRestorePreview");
    expect(calls[0].params).toMatchObject({
      threadId: "t1",
      turnId: "u1",
      cwd: "/Users/me/repo",
    });
  });
});

describe("applyCheckpointRestore", () => {
  it("always sends confirmDestructiveRestore: true and the expectedTargetCommit", async () => {
    const { rpc, calls } = fakeRpc(() => ({
      success: true,
      repoRoot: "/Users/me/repo",
      checkpointRef: "r",
      backupCheckpointRef: "br",
      backupCommit: "bcommit",
      restoredFiles: ["a.ts"],
    }));
    const result = await applyCheckpointRestore(
      rpc,
      { threadId: "t1", turnId: "u1", cwd: "/Users/me/repo" },
      { expectedTargetCommit: "deadbeef" }
    );
    expect(result.success).toBe(true);
    expect(result.restoredFiles).toEqual(["a.ts"]);
    expect(calls[0].params).toMatchObject({
      confirmDestructiveRestore: true,
      expectedTargetCommit: "deadbeef",
    });
  });
});

describe("checkpoints-store", () => {
  it("show() loads the preview and stamps it on state", async () => {
    const { rpc } = fakeRpc(() => ({
      canRestore: true,
      repoRoot: "/Users/me/repo",
      checkpointRef: "ref",
      commit: "c",
      affectedFiles: ["x.ts"],
    }));
    await useCheckpointsStore.getState().show(rpc, {
      threadId: "t1",
      turnId: "u1",
      cwd: "/Users/me/repo",
    });
    const state = useCheckpointsStore.getState();
    expect(state.open).toBe(true);
    expect(state.preview?.affectedFiles).toEqual(["x.ts"]);
    expect(state.error).toBeNull();
  });

  it("show() captures errors without leaving open=false", async () => {
    const { rpc } = fakeRpc(() => {
      throw Object.assign(new Error("denied"), { userMessage: "Bridge said no." });
    });
    await useCheckpointsStore.getState().show(rpc, {
      threadId: "t1",
      turnId: "u1",
      cwd: "/Users/me/repo",
    });
    const state = useCheckpointsStore.getState();
    expect(state.open).toBe(true);
    expect(state.preview).toBeNull();
    expect(state.error).toBe("Bridge said no.");
  });

  it("apply() requires a preview before calling the bridge", async () => {
    const { rpc, calls } = fakeRpc(() => ({}));
    const ok = await useCheckpointsStore.getState().apply(rpc);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("apply() closes the modal on success and exposes restoredFiles", async () => {
    const { rpc } = fakeRpc((call) => {
      if (call.method === "workspace/checkpointRestorePreview") {
        return { canRestore: true, commit: "c", affectedFiles: ["a.ts"] };
      }
      return { success: true, restoredFiles: ["a.ts", "b.ts"] };
    });
    await useCheckpointsStore.getState().show(rpc, {
      threadId: "t1",
      turnId: "u1",
      cwd: "/Users/me/repo",
    });
    const ok = await useCheckpointsStore.getState().apply(rpc);
    expect(ok).toBe(true);
    expect(useCheckpointsStore.getState().open).toBe(false);
    expect(useCheckpointsStore.getState().appliedFiles).toEqual(["a.ts", "b.ts"]);
  });
});
