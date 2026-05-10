// Sound cue: silent at default volume, plays when volume > 0, dispatches
// distinguishable tone shapes for completed vs failed. We don't actually
// emit audio — we mock the AudioContext and inspect the oscillator
// frequencies the helper sets up.

import { describe, expect, it, vi } from "vitest";
import { playTurnCue } from "../src/lib/sound-cue";

interface FakeOscillator {
  type: string;
  frequency: { value: number };
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

interface FakeGain {
  gain: {
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
}

function makeFakeContext(): { ctx: AudioContext; oscillators: FakeOscillator[] } {
  const oscillators: FakeOscillator[] = [];
  // Single shared gain stub so `osc.connect(gain).connect(destination)`
  // returns something that itself has a `.connect()` method (the chain
  // shape WebAudio actually uses).
  const sharedGain: FakeGain = {
    gain: {
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
  };
  const ctx = {
    state: "running" as AudioContextState,
    currentTime: 0,
    destination: {} as AudioDestinationNode,
    async resume() {},
    createOscillator: () => {
      const osc: FakeOscillator = {
        type: "",
        frequency: { value: 0 },
        connect: vi.fn(() => sharedGain),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(osc);
      return osc;
    },
    createGain: () => sharedGain as unknown as GainNode,
  } as unknown as AudioContext;
  return { ctx, oscillators };
}

describe("playTurnCue", () => {
  it("is a no-op when volume is 0", async () => {
    const { ctx, oscillators } = makeFakeContext();
    await playTurnCue("completed", { volume: 0, context: ctx });
    expect(oscillators).toHaveLength(0);
  });

  it("schedules two oscillators for a completed turn", async () => {
    const { ctx, oscillators } = makeFakeContext();
    await playTurnCue("completed", { volume: 0.3, context: ctx });
    expect(oscillators).toHaveLength(2);
    // Major-third pair: C5 (523.25) then E5 (659.25)
    expect(oscillators[0].frequency.value).toBeCloseTo(523.25, 1);
    expect(oscillators[1].frequency.value).toBeCloseTo(659.25, 1);
    expect(oscillators[0].start).toHaveBeenCalled();
    expect(oscillators[1].start).toHaveBeenCalled();
  });

  it("uses a different (dissonant) pair for a failed turn", async () => {
    const { ctx, oscillators } = makeFakeContext();
    await playTurnCue("failed", { volume: 0.3, context: ctx });
    expect(oscillators).toHaveLength(2);
    // A4 (440) + Bb4 (466.16) — minor second
    expect(oscillators[0].frequency.value).toBeCloseTo(440, 0);
    expect(oscillators[1].frequency.value).toBeCloseTo(466.16, 0);
  });
});
