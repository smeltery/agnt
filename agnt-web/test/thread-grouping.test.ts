import { describe, expect, it } from "vitest";
import type { CodexThread } from "../src/models";
import { groupThreadsByRecency } from "../src/state/thread-grouping";

function thread(id: string, updatedAt: number | undefined, name: string): CodexThread {
  return { id, name, syncState: "live", updatedAt };
}

// Anchor "now" to a local Wednesday noon so start-of-day bucket boundaries
// are deterministic across timezones.
const NOW = new Date(2026, 4, 6, 12, 0, 0, 0).getTime();
const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

describe("groupThreadsByRecency", () => {
  it("buckets a thread updated earlier today as Today", () => {
    const groups = groupThreadsByRecency([thread("t1", NOW - 3 * HOURS, "today")], {
      pinnedIds: new Set(),
      nowMs: NOW,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("today");
    expect(groups[0].threads.map((t) => t.id)).toEqual(["t1"]);
  });

  it("places yesterday's thread under Yesterday — distinct from Today", () => {
    const groups = groupThreadsByRecency(
      [
        thread("today", NOW - 1 * HOURS, "today"),
        thread("yest", NOW - 30 * HOURS, "yesterday"),
      ],
      { pinnedIds: new Set(), nowMs: NOW }
    );
    expect(groups.map((g) => g.id)).toEqual(["today", "yesterday"]);
  });

  it("walks a thread updated 4 days ago into This week", () => {
    const groups = groupThreadsByRecency(
      [thread("midweek", NOW - 4 * DAYS, "midweek")],
      { pinnedIds: new Set(), nowMs: NOW }
    );
    expect(groups[0].id).toBe("thisWeek");
  });

  it("anything older than 6 full days falls into Earlier", () => {
    const groups = groupThreadsByRecency(
      [thread("old", NOW - 30 * DAYS, "old")],
      { pinnedIds: new Set(), nowMs: NOW }
    );
    expect(groups[0].id).toBe("earlier");
  });

  it("threads with no updatedAt or createdAt land in Earlier (treated as timestamp 0)", () => {
    const groups = groupThreadsByRecency(
      [thread("ghost", undefined, "ghost")],
      { pinnedIds: new Set(), nowMs: NOW }
    );
    expect(groups.map((g) => g.id)).toEqual(["earlier"]);
  });

  it("pinned threads come out of their normal bucket and head a Pinned section", () => {
    const groups = groupThreadsByRecency(
      [
        thread("pinned-old", NOW - 60 * DAYS, "pinned"),
        thread("today", NOW - 2 * HOURS, "today"),
      ],
      { pinnedIds: new Set(["pinned-old"]), nowMs: NOW }
    );
    expect(groups.map((g) => g.id)).toEqual(["pinned", "today"]);
    expect(groups[0].threads.map((t) => t.id)).toEqual(["pinned-old"]);
    expect(groups[1].threads.map((t) => t.id)).toEqual(["today"]);
  });

  it("preserves input order within each bucket so the sidebar position stays stable across re-renders", () => {
    const groups = groupThreadsByRecency(
      [
        thread("a", NOW - 30 * HOURS, "a"),
        thread("b", NOW - 25 * HOURS, "b"),
        thread("c", NOW - 28 * HOURS, "c"),
      ],
      { pinnedIds: new Set(), nowMs: NOW }
    );
    expect(groups[0].threads.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array when there are no threads", () => {
    expect(groupThreadsByRecency([], { pinnedIds: new Set(), nowMs: NOW })).toEqual([]);
  });
});
