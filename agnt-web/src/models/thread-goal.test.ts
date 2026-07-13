import { describe, expect, it } from "vitest";
import { decodeThreadGoalEnvelope, normalizeGoalStatus, threadGoalNeedsAttention } from "./thread-goal";

describe("thread goals", () => {
  it("decodes camelCase goal envelopes", () => {
    const goal = decodeThreadGoalEnvelope({
      goal: {
        threadId: "thread-1",
        objective: "Ship the browser parity slice",
        status: "usage_limited",
        tokenBudget: 120_000,
        tokenUsage: 92_000,
        updatedAt: "2026-07-13T12:00:00Z",
      },
    });

    expect(goal).toMatchObject({
      threadId: "thread-1",
      objective: "Ship the browser parity slice",
      status: "usageLimited",
      tokenBudget: 120_000,
      tokenUsage: 92_000,
    });
    expect(goal?.updatedAt).toBe(Date.parse("2026-07-13T12:00:00Z"));
    expect(goal && threadGoalNeedsAttention(goal)).toBe(true);
  });

  it("falls back to the selected thread id for sparse notifications", () => {
    expect(decodeThreadGoalEnvelope({
      goal: { objective: "Keep going", status: "running" },
    }, "thread-fallback")).toMatchObject({
      threadId: "thread-fallback",
      objective: "Keep going",
      status: "active",
    });
  });

  it("normalizes status aliases defensively", () => {
    expect(normalizeGoalStatus("budget-limited")).toBe("budgetLimited");
    expect(normalizeGoalStatus("DONE")).toBe("completed");
    expect(normalizeGoalStatus("unknown")).toBeNull();
  });
});
