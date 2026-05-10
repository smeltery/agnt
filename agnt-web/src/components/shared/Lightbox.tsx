// Full-window overlay with optional sibling navigation. Esc closes; arrow
// keys cycle when the active set has more than one image. Subscribes to the
// lightbox store so any component can pop one up via show / showOne.
//
// Zoom + pan: wheel events scale around the cursor, double-click toggles
// 1× ↔ 2.5× at the click point, and click-drag pans when zoomed in. Reset
// (escape, arrow nav, image change) returns to fit-the-viewport at 1×.

import { useCallback, useEffect, useRef, useState } from "react";
import { selectCurrentImage, useLightboxStore } from "../../state/lightbox-store";

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const DOUBLE_CLICK_SCALE = 2.5;
const WHEEL_SENSITIVITY = 0.0015;

export function Lightbox() {
  const current = useLightboxStore(selectCurrentImage);
  const total = useLightboxStore((state) => state.images.length);
  const index = useLightboxStore((state) => state.index);
  const step = useLightboxStore((state) => state.step);
  const hide = useLightboxStore((state) => state.hide);

  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Reset zoom whenever the active image changes (or the lightbox closes
  // and reopens). Without this, switching siblings while zoomed would
  // strand the viewer on a random region of the new image.
  useEffect(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, [current?.src]);

  useEffect(() => {
    if (!current) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        hide();
        return;
      }
      if (event.key === "0") {
        // Numeric "0" resets zoom — mirrors the mac Preview shortcut.
        setScale(1);
        setTranslate({ x: 0, y: 0 });
        return;
      }
      if (total > 1) {
        if (event.key === "ArrowLeft") step(-1);
        else if (event.key === "ArrowRight") step(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, total, step, hide]);

  // Wheel zoom anchored on the cursor. We compute the delta in image-
  // local coordinates so the pixel under the cursor stays put as the
  // image scales — same behavior as native viewers.
  const handleWheel = useCallback((event: React.WheelEvent<HTMLImageElement>) => {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const cx = event.clientX - rect.left - rect.width / 2;
    const cy = event.clientY - rect.top - rect.height / 2;
    setScale((prev) => {
      const next = clamp(prev * Math.exp(-event.deltaY * WHEEL_SENSITIVITY), MIN_SCALE, MAX_SCALE);
      const ratio = next / prev;
      // Re-center so the cursor stays anchored on the same image pixel.
      setTranslate((t) => ({
        x: cx - (cx - t.x) * ratio,
        y: cy - (cy - t.y) * ratio,
      }));
      return next;
    });
  }, []);

  const handleDoubleClick = useCallback((event: React.MouseEvent<HTMLImageElement>) => {
    event.stopPropagation();
    if (scale > 1) {
      setScale(1);
      setTranslate({ x: 0, y: 0 });
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const cx = event.clientX - rect.left - rect.width / 2;
    const cy = event.clientY - rect.top - rect.height / 2;
    setScale(DOUBLE_CLICK_SCALE);
    // Translate so the click-point lands at the viewport center after
    // scaling. Same anchoring math as the wheel handler.
    setTranslate({
      x: -cx * (DOUBLE_CLICK_SCALE - 1),
      y: -cy * (DOUBLE_CLICK_SCALE - 1),
    });
  }, [scale]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    if (scale <= 1) return; // Pan is meaningless at fit-size.
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: translate.x,
      baseY: translate.y,
    };
  }, [scale, translate]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setTranslate({
      x: drag.baseX + (event.clientX - drag.startX),
      y: drag.baseY + (event.clientY - drag.startY),
    });
  }, []);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  if (!current) return null;
  const zoomed = scale > 1;
  return (
    <div
      ref={containerRef}
      className={"agnt-lightbox-backdrop" + (zoomed ? " agnt-lightbox-zoomed" : "")}
      role="dialog"
      aria-modal="true"
      // Backdrop click only closes when not zoomed — otherwise a casual
      // click after panning could accidentally dismiss the lightbox.
      onClick={zoomed ? undefined : hide}
    >
      {total > 1 && !zoomed && (
        <button
          type="button"
          className="agnt-lightbox-nav agnt-lightbox-nav-prev"
          onClick={(event) => {
            event.stopPropagation();
            step(-1);
          }}
          aria-label="Previous image"
        >
          ‹
        </button>
      )}
      <img
        src={current.src}
        alt={current.alt ?? "Image"}
        className="agnt-lightbox-image"
        style={{
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
          cursor: zoomed ? (dragRef.current ? "grabbing" : "grab") : "zoom-in",
          transition: dragRef.current ? "none" : "transform 120ms ease",
        }}
        onClick={(event) => event.stopPropagation()}
        onWheel={handleWheel}
        onDoubleClick={handleDoubleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        draggable={false}
      />
      {total > 1 && !zoomed && (
        <button
          type="button"
          className="agnt-lightbox-nav agnt-lightbox-nav-next"
          onClick={(event) => {
            event.stopPropagation();
            step(1);
          }}
          aria-label="Next image"
        >
          ›
        </button>
      )}
      <div className="agnt-lightbox-caption">
        {current.caption}
        {total > 1 && <span className="agnt-lightbox-counter">{index + 1} / {total}</span>}
        {zoomed && <span className="agnt-lightbox-zoom-indicator">{scale.toFixed(1)}× · double-click or 0 to reset</span>}
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
