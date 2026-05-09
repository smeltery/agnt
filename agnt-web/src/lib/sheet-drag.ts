// Pure helpers for the iOS-style sheet drag-to-dismiss gesture. Keeping the
// math out of the React component lets the dismiss-threshold rules be
// tested without a DOM env.
//
// Conventions:
//   - `delta` is the cumulative pointer Y travel since drag-start (positive =
//     dragging down, the only direction that should affect the sheet).
//   - The component clamps the visible offset to `delta >= 0` — upward
//     drags keep the sheet snapped to its rest position rather than rubber-
//     banding above it.
//   - A drag commits to dismiss when ANY of these is true:
//       1. translation past `commitDistancePx` (default 120px)
//       2. release velocity past `commitVelocityPxPerSec` (default 600)
//   - Otherwise, the sheet snaps back to rest.

export interface SheetDragSample {
  /** Pointer Y delta from drag-start, in CSS px. Positive = downward. */
  delta: number;
  /** Time since drag-start in ms. */
  elapsedMs: number;
}

export interface ShouldDismissOptions {
  commitDistancePx?: number;
  commitVelocityPxPerSec?: number;
  /** Window over which to compute release velocity (ms). Older samples are
   *  ignored so an early hesitation doesn't dilute the final flick. */
  velocityWindowMs?: number;
}

const DEFAULTS: Required<ShouldDismissOptions> = {
  commitDistancePx: 120,
  commitVelocityPxPerSec: 600,
  velocityWindowMs: 120,
};

/** Clamp the rendered offset so the sheet doesn't drift above its rest. */
export function clampDragOffset(rawDelta: number): number {
  return rawDelta > 0 ? rawDelta : 0;
}

/** Decide whether a drag should commit (dismiss) on release. */
export function shouldDismiss(
  samples: readonly SheetDragSample[],
  options: ShouldDismissOptions = {}
): boolean {
  const opts = { ...DEFAULTS, ...options };
  if (samples.length === 0) return false;
  const last = samples[samples.length - 1];
  if (last.delta >= opts.commitDistancePx) return true;
  // Velocity: derive from the tail samples within the window.
  const cutoff = last.elapsedMs - opts.velocityWindowMs;
  let earliestIdx = samples.length - 1;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (samples[i].elapsedMs <= cutoff) break;
    earliestIdx = i;
  }
  const earliest = samples[earliestIdx];
  const dt = last.elapsedMs - earliest.elapsedMs;
  if (dt <= 0) return false;
  const velocity = (last.delta - earliest.delta) / (dt / 1000);
  return velocity >= opts.commitVelocityPxPerSec;
}
