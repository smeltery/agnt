import { afterEach, describe, expect, it } from "vitest";
import type { JsonRpcClient } from "../src/protocol/jsonrpc-client";
import { __resetProjectStoreForTests, useProjectStore } from "../src/state/project-store";

afterEach(() => __resetProjectStoreForTests());

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
      return Promise.resolve(handler(call) as R);
    },
  } as unknown as JsonRpcClient;
  return { rpc, calls };
}

describe("project-store.show", () => {
  it("seeds quick locations and navigates into the first one", async () => {
    const { rpc, calls } = fakeRpc((call) => {
      if (call.method === "project/quickLocations") {
        return {
          locations: [
            { id: "home", label: "Home", path: "/Users/me" },
            { id: "developer", label: "Developer", path: "/Users/me/Developer" },
          ],
        };
      }
      if (call.method === "project/listDirectory") {
        return {
          path: "/Users/me",
          parentPath: null,
          entries: [{ name: "Developer", path: "/Users/me/Developer" }],
        };
      }
      return {};
    });
    await useProjectStore.getState().show(rpc);
    expect(calls.map((c) => c.method)).toEqual(["project/quickLocations", "project/listDirectory"]);
    const state = useProjectStore.getState();
    expect(state.open).toBe(true);
    expect(state.quickLocations).toHaveLength(2);
    expect(state.currentPath).toBe("/Users/me");
    expect(state.entries).toHaveLength(1);
  });

  it("survives quickLocations failures and still opens", async () => {
    const { rpc } = fakeRpc((call) => {
      if (call.method === "project/quickLocations") throw new Error("denied");
      if (call.method === "project/listDirectory") return { path: "/", parentPath: null, entries: [] };
      return {};
    });
    await useProjectStore.getState().show(rpc, { startPath: "/" });
    expect(useProjectStore.getState().open).toBe(true);
    expect(useProjectStore.getState().quickLocations).toEqual([]);
    expect(useProjectStore.getState().currentPath).toBe("/");
  });
});

describe("project-store.navigate + ascend + select", () => {
  it("navigates and reads parent path from listing response", async () => {
    const { rpc, calls } = fakeRpc(() => ({
      path: "/Users/me/code",
      parentPath: "/Users/me",
      entries: [{ name: "agnt", path: "/Users/me/code/agnt" }],
    }));
    await useProjectStore.getState().navigate(rpc, "/Users/me/code");
    expect(calls).toHaveLength(1);
    expect(useProjectStore.getState().parentPath).toBe("/Users/me");
  });

  it("select() stamps selectedPath on the store for the modal to read", () => {
    useProjectStore.getState().select("/some/path");
    expect(useProjectStore.getState().selectedPath).toBe("/some/path");
  });

  it("ascend() no-ops at the top of the allowed roots", async () => {
    const { rpc, calls } = fakeRpc(() => ({ path: "/", parentPath: null, entries: [] }));
    await useProjectStore.getState().navigate(rpc, "/");
    await useProjectStore.getState().ascend(rpc);
    expect(calls).toHaveLength(1);
  });
});

describe("project-store.setQuery", () => {
  it("debounces a search call, then calls project/searchDirectories", async () => {
    const { rpc, calls } = fakeRpc((call) => {
      if (call.method === "project/listDirectory") {
        return { path: "/Users/me", parentPath: null, entries: [] };
      }
      return { path: "/Users/me", entries: [{ name: "match.ts", path: "/Users/me/match.ts" }] };
    });
    await useProjectStore.getState().navigate(rpc, "/Users/me");
    useProjectStore.getState().setQuery(rpc, "ma");
    useProjectStore.getState().setQuery(rpc, "mat");
    useProjectStore.getState().setQuery(rpc, "match");
    await new Promise((resolve) => setTimeout(resolve, 280));
    const searchCalls = calls.filter((c) => c.method === "project/searchDirectories");
    expect(searchCalls.length).toBe(1);
    expect(searchCalls[0].params).toMatchObject({ path: "/Users/me", query: "match" });
  });

  it("empty query reloads the listing instead of searching", async () => {
    const { rpc, calls } = fakeRpc(() => ({ path: "/Users/me", parentPath: null, entries: [] }));
    await useProjectStore.getState().navigate(rpc, "/Users/me");
    useProjectStore.getState().setQuery(rpc, "");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((c) => c.method === "project/searchDirectories")).toHaveLength(0);
  });
});
