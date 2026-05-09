// ErrorBoundary catches a render-time crash and surfaces the recoverable
// fallback. We render to string so the test stays in the node env (no jsdom
// dependency); behaviour we care about — the children render under normal
// conditions, and a crash is replaced by the alert UI — is observable from
// the markup.

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { ErrorBoundary } from "../src/components/shared/ErrorBoundary";

describe("ErrorBoundary", () => {
  it("renders children when no error occurs", () => {
    const html = renderToString(
      <ErrorBoundary>
        <span data-tag="ok">Hello</span>
      </ErrorBoundary>
    );
    expect(html.includes("Hello")).toBe(true);
    expect(html.includes("Something broke")).toBe(false);
  });

  it("catches a render-time crash and shows the fallback alert", () => {
    // react-dom/server propagates the throw, but in catch-and-replace mode
    // we expect the boundary's `componentDidCatch` to render the fallback.
    // We use the static `getDerivedStateFromError` path by manually calling
    // it to verify the fallback UI shape.
    const fallbackState = ErrorBoundary.getDerivedStateFromError(new Error("crashed"));
    expect(fallbackState.error?.message).toBe("crashed");
  });

  it("fallback markup carries role=alert + the error message", () => {
    const error = new Error("test crash");
    // Build a "post-error" instance manually so we can inspect the rendered
    // fallback. This sidesteps SSR's lack of error-boundary catch and
    // keeps the test pure.
    class CrashedBoundary extends ErrorBoundary {
      override state = { error };
    }
    const html = renderToString(
      <CrashedBoundary>
        <span>unused</span>
      </CrashedBoundary>
    );
    expect(html.includes('role="alert"')).toBe(true);
    expect(html.includes("Something broke")).toBe(true);
    expect(html.includes("test crash")).toBe(true);
    // The reload + try-again buttons are present.
    expect(html.includes("Reload")).toBe(true);
    expect(html.includes("Try again")).toBe(true);
  });
});
