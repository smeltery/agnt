// Soft audible cue for turn-complete / turn-failed. Two short WebAudio
// beeps (a major-third pair on success; a minor-second on failure) so
// users with the tab muted in the background still get a signal when
// the desktop notification fires.
//
// We synthesize the tones rather than ship audio files: ~30 lines of
// WebAudio adds zero bytes to the bundle, and the result is consistent
// across OSes (a `<audio>` element played via Notification "sound:"
// would route through the OS notification service which silently does
// nothing on most platforms).
//
// Off by default — users have to opt in from Settings. The toggle
// persists alongside the existing notifications pref. Errors during
// playback (autoplay policy violations, no AudioContext) are swallowed:
// the failure mode is "no sound", which is also the default state.

import { prefsStore } from "../storage/prefs-store";

let cachedContext: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  // `webkitAudioContext` for old Safari; the cast keeps TS happy
  // without polluting our other modules with a `webkit` global.
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (cachedContext) return cachedContext;
  try {
    cachedContext = new Ctor();
    return cachedContext;
  } catch {
    return null;
  }
}

export type SoundOutcome = "completed" | "failed";

interface PlayOptions {
  /** Override the user's volume pref (0..1). Used in tests to silence
   *  the actual oscillator while still verifying the play path. */
  volume?: number;
  /** Override the AudioContext (for tests that mock WebAudio). */
  context?: AudioContext;
}

/** Plays the configured cue tone. No-op when the user has the volume
 *  pref at 0 (the default) or AudioContext is unavailable. */
export async function playTurnCue(outcome: SoundOutcome, options: PlayOptions = {}): Promise<void> {
  const volume = options.volume ?? (await prefsStore.loadSoundVolume());
  if (volume <= 0) return;
  const ctx = options.context ?? getContext();
  if (!ctx) return;
  // Some browsers create the context in a "suspended" state until a
  // user-gesture resumes it. Try to resume — failure is silent (we
  // can't beep without permission, but we shouldn't crash either).
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      return;
    }
  }
  // Distinguishable cues:
  //   completed → C5 + E5 (major third, "ta-da" feel)
  //   failed    → A4 + Bb4 (minor second, dissonant)
  const tones = outcome === "completed"
    ? [{ freq: 523.25, when: 0, duration: 0.12 }, { freq: 659.25, when: 0.1, duration: 0.16 }]
    : [{ freq: 440, when: 0, duration: 0.12 }, { freq: 466.16, when: 0.1, duration: 0.18 }];
  const now = ctx.currentTime;
  for (const tone of tones) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = tone.freq;
    // Quick attack + exponential decay so the cue doesn't sound like a
    // synth pad. `setValueAtTime` to start at 0, ramp to volume in 8ms,
    // then decay to ~0 over the tone's duration.
    gain.gain.setValueAtTime(0, now + tone.when);
    gain.gain.linearRampToValueAtTime(volume, now + tone.when + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, now + tone.when + tone.duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + tone.when);
    osc.stop(now + tone.when + tone.duration + 0.02);
  }
}
