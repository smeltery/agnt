// Full-window overlay that shows a single image at its natural max size.
// Click the backdrop or press Escape to close. Subscribes to the lightbox
// store so any component can pop one up by calling useLightboxStore
// .getState().show(...) — no prop wiring needed.

import { useEffect } from "react";
import { useLightboxStore } from "../../state/lightbox-store";

export function Lightbox() {
  const current = useLightboxStore((state) => state.current);
  const hide = useLightboxStore((state) => state.hide);

  useEffect(() => {
    if (!current) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, hide]);

  if (!current) return null;
  return (
    <div className="agnt-lightbox-backdrop" role="dialog" aria-modal="true" onClick={hide}>
      <img
        src={current.src}
        alt={current.alt ?? "Image"}
        className="agnt-lightbox-image"
        onClick={(event) => event.stopPropagation()}
      />
      {current.caption && <div className="agnt-lightbox-caption">{current.caption}</div>}
    </div>
  );
}
