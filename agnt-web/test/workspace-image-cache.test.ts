import { afterEach, describe, expect, it } from "vitest";
import type { JsonRpcClient } from "../src/protocol/jsonrpc-client";
import {
  __resetWorkspaceImageCacheForTests,
  selectImageState,
  useWorkspaceImageCache,
} from "../src/state/workspace-image-cache";

afterEach(() => __resetWorkspaceImageCacheForTests());

interface ScriptedCall {
  method: string;
  params: Record<string, unknown>;
}

function fakeRpc(handler: (call: ScriptedCall) => unknown): {
  rpc: JsonRpcClient;
  calls: ScriptedCall[];
} {
  const calls: ScriptedCall[] = [];
  const rpc = {
    request<R>(method: string, params: unknown): Promise<R> {
      const call: ScriptedCall = { method, params: params as Record<string, unknown> };
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

describe("workspace-image-cache", () => {
  it("first ensure() fires workspace/readImage and stores the data URL", async () => {
    const { rpc, calls } = fakeRpc(() => ({
      path: "/repo/cap.png",
      fileName: "cap.png",
      mimeType: "image/png",
      byteLength: 100,
      mtimeMs: 12345,
      dataBase64: "aGVsbG8=",
    }));
    const entry = await useWorkspaceImageCache.getState().ensure(rpc, {
      cwd: "/repo",
      path: "cap.png",
    });
    expect(entry?.dataUrl).toBe("data:image/png;base64,aGVsbG8=");
    expect(entry?.byteLength).toBe(100);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toMatchObject({ cwd: "/repo", path: "cap.png", maxPixelDimension: 1024 });
  });

  it("notModified probe keeps the cached entry without replacing it", async () => {
    let invocations = 0;
    const { rpc, calls } = fakeRpc(() => {
      invocations += 1;
      if (invocations === 1) {
        return {
          path: "/repo/cap.png",
          fileName: "cap.png",
          mimeType: "image/png",
          byteLength: 100,
          mtimeMs: 12345,
          dataBase64: "aGVsbG8=",
        };
      }
      return { path: "/repo/cap.png", fileName: "cap.png", mimeType: "image/png", byteLength: 100, mtimeMs: 12345, notModified: true };
    });
    const first = await useWorkspaceImageCache.getState().ensure(rpc, { cwd: "/repo", path: "cap.png" });
    const second = await useWorkspaceImageCache.getState().ensure(rpc, { cwd: "/repo", path: "cap.png" });
    expect(first?.dataUrl).toBe("data:image/png;base64,aGVsbG8=");
    expect(second?.dataUrl).toBe("data:image/png;base64,aGVsbG8=");
    // The probe call should have included the cached metadata so the bridge
    // could short-circuit.
    expect(calls[1]?.params.ifByteLength).toBe(100);
    expect(calls[1]?.params.ifMtimeMs).toBe(12345);
  });

  it("error responses surface as { error } sentinels keyed by cwd::path", async () => {
    const { rpc } = fakeRpc(() => {
      throw Object.assign(new Error("not_allowed"), { userMessage: "Path not allowed." });
    });
    await useWorkspaceImageCache.getState().ensure(rpc, { cwd: "/repo", path: "evil.png" });
    const state = useWorkspaceImageCache.getState();
    const entry = selectImageState("/repo", "evil.png")(state);
    expect(entry).toEqual({ error: "Path not allowed." });
  });

  it("two paths under different cwds don't collide", async () => {
    const { rpc } = fakeRpc((call) => ({
      path: `${call.params.cwd}/${call.params.path}`,
      fileName: "x.png",
      mimeType: "image/png",
      // Tag the byteLength with the cwd so the entries are observably
      // different and we're testing the cache key, not coincidental equality.
      byteLength: call.params.cwd === "/a" ? 100 : 200,
      dataBase64: "AA==",
    }));
    await useWorkspaceImageCache.getState().ensure(rpc, { cwd: "/a", path: "shared.png" });
    await useWorkspaceImageCache.getState().ensure(rpc, { cwd: "/b", path: "shared.png" });
    const state = useWorkspaceImageCache.getState();
    const a = selectImageState("/a", "shared.png")(state);
    const b = selectImageState("/b", "shared.png")(state);
    expect(a && typeof a === "object" && "byteLength" in a ? a.byteLength : null).toBe(100);
    expect(b && typeof b === "object" && "byteLength" in b ? b.byteLength : null).toBe(200);
  });
});
