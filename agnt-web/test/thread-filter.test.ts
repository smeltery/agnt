import { describe, expect, it } from "vitest";
import type { CodexThread } from "../src/models";
import { filterThreads } from "../src/state/thread-filter";

const threads: CodexThread[] = [
  {
    id: "t1",
    title: "Refactor auth flow",
    name: undefined,
    cwd: "/Users/me/auth-svc",
    syncState: "live",
    modelProvider: "codex",
  },
  {
    id: "t2",
    title: undefined,
    name: "Customer report bug",
    cwd: "/Users/me/dashboard",
    syncState: "live",
    agentNickname: "claude",
  },
  {
    id: "t3",
    title: "Untitled",
    cwd: "/tmp/scratch",
    syncState: "archivedLocal",
    model: "gpt-5",
  },
];

describe("filterThreads", () => {
  it("returns the input unchanged for an empty query", () => {
    expect(filterThreads(threads, "")).toBe(threads);
    expect(filterThreads(threads, "   ")).toBe(threads);
  });

  it("matches case-insensitively against title", () => {
    expect(filterThreads(threads, "AUTH").map((t) => t.id)).toEqual(["t1"]);
  });

  it("matches against name (when title is missing)", () => {
    expect(filterThreads(threads, "customer").map((t) => t.id)).toEqual(["t2"]);
  });

  it("matches against cwd path so users can find threads by directory", () => {
    expect(filterThreads(threads, "scratch").map((t) => t.id)).toEqual(["t3"]);
  });

  it("matches against agent metadata + model fields", () => {
    expect(filterThreads(threads, "claude").map((t) => t.id)).toEqual(["t2"]);
    expect(filterThreads(threads, "gpt-5").map((t) => t.id)).toEqual(["t3"]);
    expect(filterThreads(threads, "codex").map((t) => t.id)).toEqual(["t1"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterThreads(threads, "doesnotexist")).toEqual([]);
  });
});
