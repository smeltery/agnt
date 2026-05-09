// Sheet drag-to-dismiss math: clamping, distance threshold, velocity flick.

import { describe, expect, it } from "vitest";
import { clampDragOffset, shouldDismiss } from "../src/lib/sheet-drag";

describe("clampDragOffset", () => {
  it("returns the delta unchanged for downward drags", () => {
    expect(clampDragOffset(80)).toBe(80);
    expect(clampDragOffset(0)).toBe(0);
  });
  it("clamps upward drags to zero (no rubber-band above rest)", () => {
    expect(clampDragOffset(-30)).toBe(0);
  });
});

describe("shouldDismiss", () => {
  it("returns false on an empty sample stream", () => {
    expect(shouldDismiss([])).toBe(false);
  });

  it("commits when distance crosses the default threshold", () => {
    expect(
      shouldDismiss([
        { delta: 0, elapsedMs: 0 },
        { delta: 60, elapsedMs: 100 },
        { delta: 130, elapsedMs: 200 },
      ])
    ).toBe(true);
  });

  it("does not commit when distance is below threshold and velocity is low", () => {
    expect(
      shouldDismiss([
        { delta: 0, elapsedMs: 0 },
        { delta: 30, elapsedMs: 100 },
        { delta: 70, elapsedMs: 800 },
      ])
    ).toBe(false);
  });

  it("commits on a fast flick even when total distance is short", () => {
    // Fine-grained samples so the trailing 120ms window captures more than
    // one entry. Last-window delta ≈ 50px over 70ms = ~714 px/s, past the
    // default 600 threshold.
    expect(
      shouldDismiss([
        { delta: 0, elapsedMs: 0 },
        { delta: 5, elapsedMs: 200 },
        { delta: 40, elapsedMs: 250 },
        { delta: 90, elapsedMs: 320 },
      ])
    ).toBe(true);
  });

  it("custom thresholds override the defaults", () => {
    const samples = [
      { delta: 0, elapsedMs: 0 },
      { delta: 50, elapsedMs: 100 },
    ];
    expect(shouldDismiss(samples, { commitDistancePx: 40 })).toBe(true);
    expect(shouldDismiss(samples, { commitDistancePx: 200, commitVelocityPxPerSec: 99999 })).toBe(false);
  });
});
