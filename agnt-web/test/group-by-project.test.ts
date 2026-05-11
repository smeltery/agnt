// groupThreadsByProject: cwd-bucketed sidebar grouping. Pinned threads
// keep their own bucket; no-cwd threads cluster under "Other"; projects
// sort by their newest thread.

import { describe, expect, it } from "vitest";
import { groupThreadsByProject } from "../src/state/thread-grouping";
import type { CodexThread } from "../src/models";

function thread(id: string, partial: Partial<CodexThread> = {}): CodexThread {
  return {
    id,
    title: id,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  } as CodexThread;
}

describe("groupThreadsByProject", () => {
  it("returns [] for an empty input", () => {
    expect(groupThreadsByProject([], { pinnedIds: new Set() })).toEqual([]);
  });

  it("buckets threads by cwd; sorts project groups by newest thread", () => {
    const threads = [
      thread("a", { cwd: "/repo/foo", updatedAt: 1_000 }),
      thread("b", { cwd: "/repo/bar", updatedAt: 5_000 }),
      thread("c", { cwd: "/repo/foo", updatedAt: 9_000 }),
    ];
    const groups = groupThreadsByProject(threads, { pinnedIds: new Set() });
    expect(groups.map((g) => g.label)).toEqual(["foo", "bar"]);
    expect(groups[0].threads.map((t) => t.id)).toEqual(["c", "a"]);
    expect(groups[1].threads.map((t) => t.id)).toEqual(["b"]);
  });

  it("keeps a 'Pinned' bucket first when pins are present", () => {
    const threads = [
      thread("pinned-one", { cwd: "/x", updatedAt: 1 }),
      thread("a", { cwd: "/y", updatedAt: 2 }),
    ];
    const groups = groupThreadsByProject(threads, { pinnedIds: new Set(["pinned-one"]) });
    expect(groups[0].id).toBe("pinned");
    expect(groups[0].threads.map((t) => t.id)).toEqual(["pinned-one"]);
    // Pinned thread should NOT also appear under its cwd bucket.
    expect(groups[1].threads.map((t) => t.id)).toEqual(["a"]);
  });

  it("collects no-cwd threads into an 'Other' bucket that sorts last", () => {
    const threads = [
      thread("orphan", { updatedAt: 100 }),
      thread("project-a", { cwd: "/repo/a", updatedAt: 50 }),
    ];
    const groups = groupThreadsByProject(threads, { pinnedIds: new Set() });
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(["a", "Other"]);
  });

  it("project-id is prefixed so it can't collide with recency bucket ids", () => {
    const groups = groupThreadsByProject(
      [thread("a", { cwd: "/repo/foo", updatedAt: 1 })],
      { pinnedIds: new Set() }
    );
    expect(groups[0].id).toBe("project:/repo/foo");
  });

  it("uses the trailing path component as the group label", () => {
    const groups = groupThreadsByProject(
      [thread("a", { cwd: "/Users/alice/code/agnt", updatedAt: 1 })],
      { pinnedIds: new Set() }
    );
    expect(groups[0].label).toBe("agnt");
  });

  it("strips trailing slashes from the cwd when deriving the label", () => {
    const groups = groupThreadsByProject(
      [thread("a", { cwd: "/repo/foo/", updatedAt: 1 })],
      { pinnedIds: new Set() }
    );
    expect(groups[0].label).toBe("foo");
  });
});
