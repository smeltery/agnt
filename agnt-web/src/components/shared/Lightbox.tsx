// Full-window overlay with optional sibling navigation. Esc closes; arrow
// keys cycle when the active set has more than one image. Subscribes to the
// lightbox store so any component can pop one up via show / showOne.

import { useEffect } from "react";
import { selectCurrentImage, useLightboxStore } from "../../state/lightbox-store";

export function Lightbox() {
  const current = useLightboxStore(selectCurrentImage);
  const total = useLightboxStore((state) => state.images.length);
  const index = useLightboxStore((state) => state.index);
  const step = useLightboxStore((state) => state.step);
  const hide = useLightboxStore((state) => state.hide);

  useEffect(() => {
    if (!current) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        hide();
        return;
      }
      if (total > 1) {
        if (event.key === "ArrowLeft") {
          step(-1);
        } else if (event.key === "ArrowRight") {
          step(1);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, total, step, hide]);

  if (!current) return null;
  return (
    <div className="agnt-lightbox-backdrop" role="dialog" aria-modal="true" onClick={hide}>
      {total > 1 && (
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
        onClick={(event) => event.stopPropagation()}
      />
      {total > 1 && (
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
      </div>
    </div>
  );
}
