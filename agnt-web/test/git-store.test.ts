import { describe, expect, it } from "vitest";
import { decodeBranches, decodeRepoSync } from "../src/state/git-store";

describe("decodeRepoSync", () => {
  it("decodes a typical git/status response", () => {
    const status = decodeRepoSync({
      isRepo: true,
      repoRoot: "/Users/me/repo",
      branch: "main",
      tracking: "origin/main",
      dirty: true,
      ahead: 2,
      behind: 1,
      state: "ahead_behind",
      canPush: true,
      publishedToRemote: true,
      files: [
        { path: "src/a.ts", status: "M " },
        { path: "src/b.ts", status: "A " },
      ],
      diff: { filesChanged: 2, insertions: 30, deletions: 5 },
    });
    expect(status).toMatchObject({
      isGitRepository: true,
      repoRoot: "/Users/me/repo",
      currentBranch: "main",
      trackingBranch: "origin/main",
      isDirty: true,
      aheadCount: 2,
      behindCount: 1,
      canPush: true,
    });
    expect(status.files).toEqual([
      { path: "src/a.ts", status: "M" },
      { path: "src/b.ts", status: "A" },
    ]);
    expect(status.diffTotals).toEqual({ filesChanged: 2, insertions: 30, deletions: 5 });
  });

  it("treats missing isRepo as a repo (matches iOS default)", () => {
    expect(decodeRepoSync({}).isGitRepository).toBe(true);
  });

  it("returns no diff totals when all values are zero", () => {
    expect(decodeRepoSync({ diff: { insertions: 0, deletions: 0, filesChanged: 0 } }).diffTotals).toBeUndefined();
  });

  it("filters malformed file entries", () => {
    const status = decodeRepoSync({ files: [{ path: "" }, "not-an-object", { path: "ok.ts", status: "M" }] });
    expect(status.files).toEqual([{ path: "ok.ts", status: "M" }]);
  });
});

describe("decodeBranches", () => {
  it("returns empty defaults for missing input", () => {
    const snapshot = decodeBranches(undefined);
    expect(snapshot.branches).toEqual([]);
    expect(snapshot.currentBranch).toBeUndefined();
    expect(snapshot.defaultBranch).toBeUndefined();
    expect(snapshot.branchesCheckedOutElsewhere.size).toBe(0);
  });

  it("decodes a typical git/branches response", () => {
    const snapshot = decodeBranches({
      branches: ["main", "feature/a", "feature/b"],
      current: "feature/a",
      default: "main",
      branchesCheckedOutElsewhere: ["feature/b"],
    });
    expect(snapshot.branches).toEqual(["main", "feature/a", "feature/b"]);
    expect(snapshot.currentBranch).toBe("feature/a");
    expect(snapshot.defaultBranch).toBe("main");
    expect(snapshot.branchesCheckedOutElsewhere.has("feature/b")).toBe(true);
  });

  it("filters non-string entries from arrays", () => {
    const snapshot = decodeBranches({
      branches: ["main", 42, null, "side"],
      branchesCheckedOutElsewhere: [true, "side"],
    });
    expect(snapshot.branches).toEqual(["main", "side"]);
    expect([...snapshot.branchesCheckedOutElsewhere]).toEqual(["side"]);
  });
});

describe("git-store.createBranch + createWorktree", () => {
  it("createBranch trims input and calls git/createBranch with the bridge's expected param shape", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = {
      request<R>(method: string, params: unknown): Promise<R> {
        calls.push({ method, params });
        if (method === "git/createBranch") return Promise.resolve({ branch: "feature/x" } as R);
        return Promise.resolve({ branches: [], current: "main", default: "main" } as R);
      },
    } as unknown as import("../src/protocol/jsonrpc-client").JsonRpcClient;
    const { useGitStore } = await import("../src/state/git-store");
    useGitStore.getState().reset();
    const created = await useGitStore.getState().createBranch("t1", rpc, "  feature/x  ");
    expect(created).toBe("feature/x");
    const createCall = calls.find((call) => call.method === "git/createBranch");
    expect(createCall?.params).toMatchObject({ threadId: "t1", name: "feature/x" });
  });

  it("createWorktree forwards the base branch from the current snapshot", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = {
      request<R>(method: string, params: unknown): Promise<R> {
        calls.push({ method, params });
        if (method === "git/createWorktree") {
          return Promise.resolve({ worktreePath: "/tmp/wt" } as R);
        }
        return Promise.resolve({ branches: [], current: "main", default: "main" } as R);
      },
    } as unknown as import("../src/protocol/jsonrpc-client").JsonRpcClient;
    const { useGitStore } = await import("../src/state/git-store");
    useGitStore.getState().reset();
    const path = await useGitStore.getState().createWorktree("t1", rpc, {
      branch: "feature/y",
      baseBranch: "main",
    });
    expect(path).toBe("/tmp/wt");
    const createCall = calls.find((call) => call.method === "git/createWorktree");
    expect(createCall?.params).toMatchObject({ threadId: "t1", branch: "feature/y", baseBranch: "main" });
  });

  it("createBranch surfaces empty-name errors locally without hitting the bridge", async () => {
    let called = 0;
    const rpc = {
      request<R>(): Promise<R> {
        called += 1;
        return Promise.resolve({} as R);
      },
    } as unknown as import("../src/protocol/jsonrpc-client").JsonRpcClient;
    const { useGitStore } = await import("../src/state/git-store");
    useGitStore.getState().reset();
    expect(await useGitStore.getState().createBranch("t1", rpc, "   ")).toBeNull();
    expect(called).toBe(0);
  });
});
