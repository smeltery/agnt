// iOS-style modal sheet: anchors to the bottom of the viewport, animates up
// on mount, and supports drag-to-dismiss via the grabber handle. We use
// pointer events (covering touch + mouse + pen) so iPad-via-Tailscale users
// get the same drag gesture as a desktop user with a trackpad.
//
// API mirrors the existing modal pattern (open/onClose) so callers can swap
// in this component without restructuring their state. The trick is the
// outer backdrop tracks `dragOffset` so it can dim less while the user is
// pulling the sheet down — same affordance iOS gives.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { clampDragOffset, shouldDismiss, type SheetDragSample } from "../../lib/sheet-drag";

interface SheetProps {
  open: boolean;
  onClose(): void;
  children: ReactNode;
  /** Optional accessible label, attached to the sheet container. */
  ariaLabel?: string;
  /** Cap the sheet's max width on wide viewports — defaults to 560px to
   *  match the existing modal sizing. Sheets always span 100% width on
   *  narrow viewports regardless. */
  maxWidth?: number;
}

export function Sheet({ open, onClose, children, ariaLabel, maxWidth = 560 }: SheetProps) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ pointerId: number; startY: number; startTime: number; samples: SheetDragSample[] } | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  // `mounted` plays a one-frame role so the slide-up animation kicks in
  // after the initial paint; otherwise the sheet would render at its rest
  // position and the user would never see the transition.
  const [mounted, setMounted] = useState(false);
  // While the user is actively dragging, disable the CSS transition so the
  // motion tracks the pointer 1:1; reenable once they release.
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!open) {
      setMounted(false);
      return;
    }
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Only the drag handle area initiates the gesture. The actual filter
    // happens in the JSX (the <button> at the top has its own pointerdown).
    if (event.button !== undefined && event.button !== 0) return;
    sheetRef.current?.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startTime: performance.now(),
      samples: [{ delta: 0, elapsedMs: 0 }],
    };
    setDragging(true);
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const delta = event.clientY - state.startY;
    state.samples.push({ delta, elapsedMs: performance.now() - state.startTime });
    setDragOffset(clampDragOffset(delta));
  }, []);

  const finishDrag = useCallback(
    (commit: boolean) => {
      const state = dragStateRef.current;
      dragStateRef.current = null;
      setDragging(false);
      if (commit) {
        // Animate the sheet off-screen before firing onClose, so the unmount
        // doesn't snap the bottom-anchored element back to rest mid-drag.
        const sheetHeight = sheetRef.current?.offsetHeight ?? 600;
        setDragOffset(sheetHeight);
        window.setTimeout(() => {
          onClose();
          setDragOffset(0);
        }, 200);
      } else {
        setDragOffset(0);
      }
      // Touch up the explicit-state ref-capture in case the pointerup landed
      // on a different element due to a flick.
      if (state && sheetRef.current?.hasPointerCapture(state.pointerId)) {
        sheetRef.current.releasePointerCapture(state.pointerId);
      }
    },
    [onClose]
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      finishDrag(shouldDismiss(state.samples));
    },
    [finishDrag]
  );

  const handlePointerCancel = useCallback(() => {
    finishDrag(false);
  }, [finishDrag]);

  if (!open) return null;

  const translatePx = mounted ? dragOffset : "100%";
  const sheetStyle: CSSProperties = {
    transform: typeof translatePx === "number" ? `translateY(${translatePx}px)` : `translateY(${translatePx})`,
    transition: dragging ? "none" : "transform 280ms cubic-bezier(0.32, 0.72, 0, 1)",
    maxWidth,
  };
  // Backdrop fades from clear→tinted as the sheet appears, and fades back
  // out as the user drags down. Cap at a reasonable opacity so the sheet
  // doesn't disappear into the page.
  const sheetHeight = sheetRef.current?.offsetHeight ?? 1;
  const dragProgress = Math.max(0, Math.min(1, dragOffset / sheetHeight));
  const backdropOpacity = mounted ? Math.max(0, 0.45 * (1 - dragProgress)) : 0;

  return (
    <div
      className="agnt-sheet-backdrop"
      role="presentation"
      onClick={onClose}
      style={{
        background: `rgba(0, 0, 0, ${backdropOpacity.toFixed(3)})`,
        transition: dragging ? "none" : "background 280ms cubic-bezier(0.32, 0.72, 0, 1)",
      }}
    >
      <div
        ref={sheetRef}
        className="agnt-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        style={sheetStyle}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="agnt-sheet-grabber-area"
          // The grabber is the pointer-event surface — the rest of the
          // sheet stays scrollable. iOS sheets behave the same way: only
          // the handle reliably initiates the dismiss gesture.
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        >
          <div className="agnt-sheet-grabber" aria-hidden />
        </div>
        <div className="agnt-sheet-body">{children}</div>
      </div>
    </div>
  );
}
