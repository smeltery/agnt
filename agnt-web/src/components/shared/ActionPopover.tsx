import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Non-modal controls rendered outside scroll/paint containment, with viewport-aware placement. */
export function ActionPopover({ label, trigger, children, placement = "bottom", className = "" }: {
  label: string;
  trigger: ReactNode;
  children: ReactNode;
  placement?: "top" | "bottom";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const contains = (target: Node) => root.current?.contains(target) || panel.current?.contains(target);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!button.current || !panel.current) return;
      const anchor = button.current.getBoundingClientRect();
      const bounds = panel.current.getBoundingClientRect();
      const above = anchor.top - bounds.height - 8;
      const below = anchor.bottom + 8;
      const preferred = placement === "top" ? above : below;
      const alternate = placement === "top" ? below : above;
      const top = preferred >= 8 && preferred + bounds.height <= innerHeight - 8 ? preferred : alternate;
      setPosition({
        left: Math.max(8, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 8)),
        top: Math.max(8, Math.min(top, innerHeight - bounds.height - 8)),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    const focusFrame = requestAnimationFrame(() => {
      panel.current?.querySelector<HTMLElement>("button:not(:disabled), select, input, textarea")?.focus();
    });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, placement]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return (
    <div className={`agnt-action-popover ${className}`} ref={root}
      onBlur={(event) => {
        if (event.relatedTarget && !contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }}>
      <button ref={button} type="button" className="agnt-popover-trigger" aria-label={label}
        aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => { setPosition(null); setOpen(!open); }}>
        {trigger}
      </button>
      {open && createPortal(<div className={`agnt-popover-layer ${className}`}>
        <div ref={panel} id={id} role="group" aria-label={label} className="agnt-popover-panel"
          style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? "visible" : "hidden" }}
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), select, input, textarea, a[href]")]
              .filter((element) => element.getClientRects().length > 0);
            const edge = event.shiftKey ? controls[0] : controls.at(-1);
            if (document.activeElement === edge) {
              event.preventDefault();
              setOpen(false);
              button.current?.focus();
            }
          }}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("[data-close-popover]")) {
              setOpen(false);
              button.current?.focus();
            }
          }}>{children}</div>
      </div>, document.body)}
    </div>
  );
}
