import { describe, expect, it } from "vitest";
import { fetchThreadTurnsPage, iterateThreadTurns } from "../src/state/pagination";
import type { JsonRpcClient } from "../src/protocol/jsonrpc-client";

function fakeRpc(scriptedResponses: Array<unknown>): {
  rpc: JsonRpcClient;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  let cursor = 0;
  const rpc = {
    request<R>(method: string, params: unknown): Promise<R> {
      calls.push({ method, params });
      const response = scriptedResponses[cursor++];
      if (response === undefined) return Promise.reject(new Error("no more responses"));
      return Promise.resolve(response as R);
    },
  } as unknown as JsonRpcClient;
  return { rpc, calls };
}

describe("thread/turns/list pagination", () => {
  it("issues a single request with desc sortDirection and the supplied threadId", async () => {
    const { rpc, calls } = fakeRpc([{ data: [{ id: "turn-1" }], nextCursor: null }]);
    const page = await fetchThreadTurnsPage({ rpc, threadId: "t1" });
    expect(page.turns).toEqual([{ id: "turn-1" }]);
    expect(page.nextCursor).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("thread/turns/list");
    expect(calls[0].params).toMatchObject({ threadId: "t1", sortDirection: "desc" });
  });

  it("normalizes both nextCursor and next_cursor", async () => {
    const { rpc } = fakeRpc([{ data: [], next_cursor: "abc" }]);
    expect((await fetchThreadTurnsPage({ rpc, threadId: "t1" })).nextCursor).toBe("abc");
  });

  it("walks every page until cursor is exhausted", async () => {
    const { rpc, calls } = fakeRpc([
      { data: [{ id: "p1" }], nextCursor: "c1" },
      { data: [{ id: "p2" }], nextCursor: "c2" },
      { data: [{ id: "p3" }], nextCursor: null },
    ]);
    const collected: unknown[][] = [];
    for await (const chunk of iterateThreadTurns({ rpc, threadId: "t1" })) collected.push(chunk);
    expect(collected.flat()).toEqual([{ id: "p1" }, { id: "p2" }, { id: "p3" }]);
    expect(calls.map((c) => (c.params as { cursor?: string }).cursor)).toEqual([undefined, "c1", "c2"]);
  });
});
