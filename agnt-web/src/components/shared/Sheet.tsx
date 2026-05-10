// iOS-style modal sheet: anchors to the bottom of the viewport, animates up
// on mount, and supports drag-to-dismiss via the grabber handle. We use
// pointer events (covering touch + mouse + pen) so iPad-via-Tailscale users
// get the same drag gesture as a desktop user with a trackpad.
//
// Two presentations:
//   - "sheet"  (default): bottom-anchored, slide-up, grabber, drag-dismiss.
//                          Best for "tray" surfaces — pickers, forms.
//   - "alert"          : centered card, fade-in, no grabber. Best for
//                          safety-critical confirms (Revert, Approval) where
//                          accidentally dragging the dialog away would do
//                          the wrong thing.
//
// `closable` controls whether the user can dismiss the sheet (drag, backdrop
// click, Esc). Set `closable={false}` for dialogs that *require* an explicit
// button decision — the parent then calls `onClose` only when one of its
// own buttons fires. Even when `closable` is false, Esc still triggers
// `onClose` since it's a baseline accessibility expectation; the parent can
// route Esc to a "cancel" decision if it has one.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { clampDragOffset, shouldDismiss, type SheetDragSample } from "../../lib/sheet-drag";

export type SheetPresentation = "sheet" | "alert";

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
  /** "sheet" (bottom-anchored, draggable) or "alert" (centered, no drag). */
  presentation?: SheetPresentation;
  /** When false, drag-dismiss + backdrop-click are disabled. Esc still
   *  fires `onClose` so keyboard users always have an escape. */
  closable?: boolean;
}

export function Sheet({
  open,
  onClose,
  children,
  ariaLabel,
  maxWidth = 560,
  presentation = "sheet",
  closable = true,
}: SheetProps) {
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

  // Focus management: while the sheet is open, capture Tab / Shift+Tab so
  // keyboard users can't escape the dialog into the underlying chat. We
  // also restore focus to whatever was focused before opening so closing
  // a settings sheet via Esc returns the user to the gear button.
  useEffect(() => {
    if (!open) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    function focusable(): HTMLElement[] {
      // Standard "is focusable" set. We exclude `[tabindex="-1"]` because
      // those are programmatic-focus targets only — landing on them with
      // Tab usually produces dead-end behavior.
      const nodes = sheet!.querySelectorAll<HTMLElement>(
        'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), audio[controls], video[controls], [contenteditable="true"]'
      );
      return Array.from(nodes).filter((el) => !el.hasAttribute("inert"));
    }

    // Initial focus: prefer the first focusable inside the sheet so screen
    // readers announce the dialog content first. Falls back to the sheet
    // element itself with `tabindex=-1` so focus has somewhere to land.
    const candidates = focusable();
    if (candidates.length > 0) {
      candidates[0].focus();
    } else {
      sheet.tabIndex = -1;
      sheet.focus();
    }

    function onKey(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const list = focusable();
      if (list.length === 0) {
        // Pin focus to the sheet itself so Tab can't bleed out.
        event.preventDefault();
        sheet!.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // Wrap the cycle: Shift+Tab from the first focuses the last;
      // Tab from the last focuses the first. If focus is somehow outside
      // the sheet, slam it back to the first.
      if (event.shiftKey) {
        if (active === first || !sheet!.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !sheet!.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    sheet.addEventListener("keydown", onKey);
    return () => {
      sheet.removeEventListener("keydown", onKey);
      // Restore focus to the trigger when the dialog closes. Guard against
      // a stale ref (the element was removed while the sheet was open).
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  const dragEnabled = closable && presentation === "sheet";

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragEnabled) return;
    if (event.button !== undefined && event.button !== 0) return;
    sheetRef.current?.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startTime: performance.now(),
      samples: [{ delta: 0, elapsedMs: 0 }],
    };
    setDragging(true);
  }, [dragEnabled]);

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

  const isAlert = presentation === "alert";
  const translateRest = isAlert ? 0 : "100%";
  const translatePx = mounted ? dragOffset : translateRest;
  const sheetStyle: CSSProperties = {
    transform: typeof translatePx === "number" ? `translateY(${translatePx}px)` : `translateY(${translatePx})`,
    opacity: isAlert && !mounted ? 0 : undefined,
    transition: dragging ? "none" : isAlert
      ? "opacity 200ms ease, transform 200ms ease"
      : "transform 280ms cubic-bezier(0.32, 0.72, 0, 1)",
    maxWidth,
  };
  // Backdrop fades from clear→tinted as the sheet appears, and fades back
  // out as the user drags down. Cap at a reasonable opacity so the sheet
  // doesn't disappear into the page.
  const sheetHeight = sheetRef.current?.offsetHeight ?? 1;
  const dragProgress = isAlert ? 0 : Math.max(0, Math.min(1, dragOffset / sheetHeight));
  const backdropOpacity = mounted ? Math.max(0, 0.45 * (1 - dragProgress)) : 0;

  return (
    <div
      className={"agnt-sheet-backdrop" + (isAlert ? " agnt-sheet-backdrop-alert" : "")}
      role="presentation"
      onClick={closable ? onClose : undefined}
      style={{
        background: `rgba(0, 0, 0, ${backdropOpacity.toFixed(3)})`,
        transition: dragging ? "none" : "background 280ms cubic-bezier(0.32, 0.72, 0, 1)",
      }}
    >
      <div
        ref={sheetRef}
        className={"agnt-sheet" + (isAlert ? " agnt-sheet-alert" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        style={sheetStyle}
        onClick={(event) => event.stopPropagation()}
      >
        {dragEnabled && (
          <div
            className="agnt-sheet-grabber-area"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
          >
            <div className="agnt-sheet-grabber" aria-hidden />
          </div>
        )}
        <div className="agnt-sheet-body">{children}</div>
      </div>
    </div>
  );
}
