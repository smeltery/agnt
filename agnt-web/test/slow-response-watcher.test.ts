// Slow-response watcher: arms a per-turn timer that emits a toast at 15s.
// We assert the timer / cancel / replace semantics — the toast text itself
// is just a hand-off to notices-store.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNoticesStore } from "../src/state/notices-store";
import {
  __pendingSlowResponseTurnsForTests,
  __resetSlowResponseWatchersForTests,
  armSlowResponseWatch,
  cancelSlowResponseWatch,
} from "../src/state/slow-response-watcher";

beforeEach(() => {
  __resetSlowResponseWatchersForTests();
  useNoticesStore.setState({ notices: [] });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("slow-response-watcher", () => {
  it("emits a notice after 15s", () => {
    armSlowResponseWatch("turn-1");
    expect(useNoticesStore.getState().notices).toHaveLength(0);
    vi.advanceTimersByTime(14_999);
    expect(useNoticesStore.getState().notices).toHaveLength(0);
    vi.advanceTimersByTime(2);
    const notices = useNoticesStore.getState().notices;
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toBe("Still working…");
    expect(notices[0].severity).toBe("info");
  });

  it("cancel() prevents the toast", () => {
    armSlowResponseWatch("turn-1");
    cancelSlowResponseWatch("turn-1");
    vi.advanceTimersByTime(20_000);
    expect(useNoticesStore.getState().notices).toHaveLength(0);
  });

  it("re-arming the same turnId resets the timer", () => {
    armSlowResponseWatch("turn-1");
    vi.advanceTimersByTime(10_000);
    armSlowResponseWatch("turn-1"); // resets back to 0
    vi.advanceTimersByTime(10_000);
    expect(useNoticesStore.getState().notices).toHaveLength(0);
    vi.advanceTimersByTime(5_001);
    expect(useNoticesStore.getState().notices).toHaveLength(1);
  });

  it("clears its bookkeeping after the toast fires", () => {
    armSlowResponseWatch("turn-1");
    vi.advanceTimersByTime(15_001);
    expect(__pendingSlowResponseTurnsForTests()).toEqual([]);
  });

  it("tracks multiple in-flight turns independently", () => {
    armSlowResponseWatch("turn-A");
    armSlowResponseWatch("turn-B");
    expect(__pendingSlowResponseTurnsForTests().sort()).toEqual(["turn-A", "turn-B"]);
    cancelSlowResponseWatch("turn-A");
    expect(__pendingSlowResponseTurnsForTests()).toEqual(["turn-B"]);
  });
});
