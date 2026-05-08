import { beforeEach, describe, expect, it } from "vitest";
import { decodePlanSteps, orderCounter } from "../src/models";
import {
  applyPlanDelta,
  applyPlanUpdated,
  applyTurnCompleted,
  applyTurnStarted,
  emptyThreadState,
} from "../src/state/turn-reducer";

beforeEach(() => orderCounter.__resetForTests());

describe("plan-mode reducer", () => {
  it("creates a single plan row per turn for turn/plan/updated and merges later updates", () => {
    let state = emptyThreadState();
    state = applyTurnStarted(state, { threadId: "t", turnId: "u" });
    state = applyPlanUpdated(state, {
      threadId: "t",
      turnId: "u",
      explanation: "first",
      steps: [{ step: "discover", status: "in_progress" }],
    });
    state = applyPlanUpdated(state, {
      threadId: "t",
      turnId: "u",
      explanation: "second",
      steps: [
        { step: "discover", status: "completed" },
        { step: "implement", status: "in_progress" },
      ],
    });
    expect(state.messages.filter((m) => m.kind === "plan")).toHaveLength(1);
    const row = state.messages.find((m) => m.kind === "plan");
    expect(row?.plan?.explanation).toBe("second");
    expect(row?.plan?.steps).toEqual([
      { step: "discover", status: "completed" },
      { step: "implement", status: "in_progress" },
    ]);
    expect(row?.plan?.presentation).toBe("progress");
  });

  it("streams plan text into a separate per-item row in resultStreaming presentation", () => {
    let state = emptyThreadState();
    state = applyTurnStarted(state, { threadId: "t", turnId: "u" });
    state = applyPlanUpdated(state, {
      threadId: "t",
      turnId: "u",
      steps: [{ step: "step", status: "in_progress" }],
    });
    state = applyPlanDelta(state, { threadId: "t", turnId: "u", itemId: "i1", delta: "I will" });
    state = applyPlanDelta(state, { threadId: "t", turnId: "u", itemId: "i1", delta: " do X." });
    const planRows = state.messages.filter((m) => m.kind === "plan");
    expect(planRows).toHaveLength(2);
    const stream = planRows.find((row) => row.itemId === "i1");
    expect(stream?.text).toBe("I will do X.");
    expect(stream?.plan?.presentation).toBe("resultStreaming");
  });

  it("transitions plan presentation from resultStreaming to resultReady when the turn closes", () => {
    let state = emptyThreadState();
    state = applyTurnStarted(state, { threadId: "t", turnId: "u" });
    state = applyPlanDelta(state, { threadId: "t", turnId: "u", itemId: "i1", delta: "draft" });
    state = applyTurnCompleted(state, { threadId: "t", turnId: "u" });
    const stream = state.messages.find((m) => m.kind === "plan" && m.itemId === "i1");
    expect(stream?.plan?.presentation).toBe("resultReady");
    expect(stream?.isStreaming).toBe(false);
  });
});

describe("decodePlanSteps", () => {
  it("filters empty steps and unknown statuses", () => {
    const steps = decodePlanSteps([
      { step: "alpha", status: "completed" },
      { step: "", status: "completed" },
      { step: "beta", status: "weird" },
      "not an object",
      { text: "gamma", status: "in_progress" },
    ]);
    expect(steps).toEqual([
      { step: "alpha", status: "completed" },
      { step: "beta", status: "pending" },
      { step: "gamma", status: "in_progress" },
    ]);
  });

  it("returns an empty array for non-array input", () => {
    expect(decodePlanSteps(null)).toEqual([]);
    expect(decodePlanSteps({})).toEqual([]);
    expect(decodePlanSteps(undefined)).toEqual([]);
  });
});
