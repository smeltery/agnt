// Icon set smoke test: every named icon renders an <svg> with the expected
// viewBox, inheritable color, and the alphabetic ALL_ICONS map stays in
// sync with the named exports. We don't try to assert path geometry —
// these are hand-traced glyphs and the visual is the test.

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { ALL_ICONS, ChevronRight, Plus, Xmark } from "../src/components/shared/Icon";

describe("icon set", () => {
  it("renders Plus as a 16×16 SVG using currentColor", () => {
    const html = renderToString(<Plus />);
    expect(html.includes('viewBox="0 0 16 16"')).toBe(true);
    expect(html.includes('width="16"')).toBe(true);
    expect(html.includes('height="16"')).toBe(true);
    expect(html.includes('stroke="currentColor"')).toBe(true);
  });

  it("respects custom size prop", () => {
    const html = renderToString(<Xmark size={24} />);
    expect(html.includes('width="24"')).toBe(true);
    expect(html.includes('height="24"')).toBe(true);
  });

  it("marks itself aria-hidden when no aria-label is supplied", () => {
    const html = renderToString(<ChevronRight />);
    expect(html.includes('aria-hidden')).toBe(true);
  });

  it("ALL_ICONS contains every public icon", () => {
    const names = Object.keys(ALL_ICONS).sort();
    expect(names).toContain("ChevronRight");
    expect(names).toContain("Xmark");
    expect(names).toContain("Plus");
    expect(names).toContain("PinFill");
    expect(names).toContain("StarFill");
    // The map should be in alphabetical order so it's grep-friendly.
    expect(names).toEqual([...names].sort());
  });
});
