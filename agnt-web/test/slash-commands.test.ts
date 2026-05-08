import { describe, expect, it } from "vitest";
import { filterSlashCommands, SLASH_COMMANDS } from "../src/state/slash-commands";
import type { ThreadsState } from "../src/state/threads-store";

function fakeThreadsState(overrides: Partial<ThreadsState> = {}): ThreadsState {
  // The slash-command catalog only reads a small slice of the threads store
  // (threads, archivedThreads, reducerStates) so the rest can be stubbed.
  return {
    threads: [],
    archivedThreads: [],
    reducerStates: {},
    contextUsageByThread: {},
    runningThreadIds: new Set(),
    pinnedThreadIds: new Set(),
    lastVisitedByThread: {},
    colorByThread: {},
    models: [],
    selectedThreadId: null,
    turnFlags: {},
    loading: false,
    error: null,
    hydrated: true,
    bindToConnection: async () => {},
    hydrateFromDisk: async () => {},
    selectThread: async () => {},
    loadOlderTurns: async () => {},
    sendTurn: async () => {},
    retryFailedTurn: async () => false,
    startNewThread: async () => null,
    stopTurn: async () => {},
    patchTurnFlags: () => {},
    forkThread: async () => null,
    renameThread: async () => {},
    archiveThread: async () => {},
    unarchiveThread: async () => {},
    compactThread: async () => false,
    togglePinThread: async () => {},
    reorderPinnedThreads: async () => {},
    markThreadUnread: async () => {},
    setThreadColor: async () => {},
    reset: () => {},
    ...overrides,
  };
}

describe("filterSlashCommands", () => {
  it("returns every runnable command for an empty query", () => {
    const threads = fakeThreadsState({
      threads: [{ id: "t1", syncState: "live" }],
    });
    const result = filterSlashCommands("", { threadId: "t1", threads });
    // archive is runnable (thread is in `threads`); unarchive is not (it's
    // not in `archivedThreads`); stop is not (no active turn).
    const names = result.map((command) => command.name);
    expect(names).toContain("compact");
    expect(names).toContain("fork");
    expect(names).toContain("archive");
    expect(names).not.toContain("unarchive");
    expect(names).not.toContain("stop");
  });

  it("filters by case-insensitive prefix on the command name", () => {
    const threads = fakeThreadsState({
      threads: [{ id: "t1", syncState: "live" }],
    });
    const result = filterSlashCommands("COM", { threadId: "t1", threads });
    expect(result.map((command) => command.name)).toEqual(["compact"]);
  });

  it("matches aliases too — `/interrupt` resolves to stop", () => {
    const threads = fakeThreadsState({
      reducerStates: {
        t1: {
          messages: [],
          streamingByItem: {},
          streamingFallbackByTurn: {},
          streamingReasoningByItem: {},
          streamingStructuredByItem: {},
          streamingPlanByKey: {},
          terminalTurns: {},
          activeTurnId: "u1",
        },
      },
    });
    const result = filterSlashCommands("interrupt", { threadId: "t1", threads });
    expect(result.map((command) => command.name)).toEqual(["stop"]);
  });

  it("hides unarchive when the thread isn't archived (and vice versa)", () => {
    const inLive = fakeThreadsState({
      threads: [{ id: "t1", syncState: "live" }],
    });
    const inArchive = fakeThreadsState({
      archivedThreads: [{ id: "t1", syncState: "archivedLocal" }],
    });
    const live = filterSlashCommands("arch", { threadId: "t1", threads: inLive }).map((c) => c.name);
    const archived = filterSlashCommands("arch", { threadId: "t1", threads: inArchive }).map((c) => c.name);
    expect(live).toContain("archive");
    expect(live).not.toContain("unarchive");
    expect(archived).toContain("unarchive");
    expect(archived).not.toContain("archive");
  });

  it("hides every command when there's no selected thread", () => {
    const threads = fakeThreadsState();
    const result = filterSlashCommands("", { threadId: "", threads });
    // Every command in the catalog requires a threadId, so nothing should match.
    expect(result).toEqual([]);
    // Catalog itself is non-empty, so we're testing the gate, not vacuity.
    expect(SLASH_COMMANDS.length).toBeGreaterThan(0);
  });
});
