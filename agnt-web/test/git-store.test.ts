import { describe, expect, it } from "vitest";
import { decodeRepoSync } from "../src/state/git-store";

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
