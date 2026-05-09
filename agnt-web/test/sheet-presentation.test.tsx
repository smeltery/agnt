// Sheet `presentation` + `closable` props govern the user's escape
// affordances. We render to string and inspect the DOM structure rather
// than wiring jsdom — the props that matter (grabber present, backdrop
// dismiss handler) are observable from the markup + class names.

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { Sheet } from "../src/components/shared/Sheet";

describe("Sheet presentation", () => {
  it("default sheet mode renders the grabber handle", () => {
    const html = renderToString(
      <Sheet open onClose={() => {}}>
        <span>body</span>
      </Sheet>
    );
    expect(html.includes("agnt-sheet-grabber")).toBe(true);
    expect(html.includes("agnt-sheet-alert")).toBe(false);
  });

  it("alert mode skips the grabber + adds the alert class", () => {
    const html = renderToString(
      <Sheet open onClose={() => {}} presentation="alert">
        <span>body</span>
      </Sheet>
    );
    expect(html.includes("agnt-sheet-grabber")).toBe(false);
    expect(html.includes("agnt-sheet-alert")).toBe(true);
    expect(html.includes("agnt-sheet-backdrop-alert")).toBe(true);
  });

  it("closable=false skips the grabber even in sheet mode", () => {
    const html = renderToString(
      <Sheet open onClose={() => {}} closable={false}>
        <span>body</span>
      </Sheet>
    );
    expect(html.includes("agnt-sheet-grabber")).toBe(false);
  });

  it("renders nothing when open=false", () => {
    const html = renderToString(
      <Sheet open={false} onClose={() => {}}>
        <span>body</span>
      </Sheet>
    );
    expect(html).toBe("");
  });

  it("attaches the dialog role + aria-label", () => {
    const html = renderToString(
      <Sheet open onClose={() => {}} ariaLabel="Custom dialog">
        <span>body</span>
      </Sheet>
    );
    expect(html.includes('role="dialog"')).toBe(true);
    expect(html.includes('aria-label="Custom dialog"')).toBe(true);
    expect(html.includes('aria-modal="true"')).toBe(true);
  });
});
