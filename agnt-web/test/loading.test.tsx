// Loading + empty-state primitives. Smoke test only — these are
// presentational. The point is to make sure they render with appropriate
// counts + accessibility roles.

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { EmptyState, SidebarSkeleton } from "../src/components/shared/Loading";

describe("SidebarSkeleton", () => {
  it("renders the requested number of shimmer rows", () => {
    const html = renderToString(<SidebarSkeleton count={4} />);
    const rowMatches = html.match(/agnt-skeleton-row/g) ?? [];
    expect(rowMatches.length).toBe(4);
  });

  it("defaults to 6 shimmer rows", () => {
    const html = renderToString(<SidebarSkeleton />);
    const rowMatches = html.match(/agnt-skeleton-row/g) ?? [];
    expect(rowMatches.length).toBe(6);
  });

  it("hides itself from screen readers", () => {
    const html = renderToString(<SidebarSkeleton />);
    expect(html.includes("aria-hidden")).toBe(true);
  });
});

describe("EmptyState", () => {
  it("renders title + message and exposes a status role", () => {
    const html = renderToString(
      <EmptyState title="No threads yet" message="Tap + New to start one." />
    );
    expect(html.includes("No threads yet")).toBe(true);
    expect(html.includes("Tap + New to start one.")).toBe(true);
    expect(html.includes('role="status"')).toBe(true);
  });

  it("omits the icon container when no icon is supplied", () => {
    const html = renderToString(<EmptyState title="Empty" />);
    expect(html.includes("agnt-empty-state-icon")).toBe(false);
  });
});
