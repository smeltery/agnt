// Relative-time formatter. Boundaries that matter: the "just now" floor,
// the m/h/d transitions, and the fall-back to absolute past a week.
//
// We pin `locale: "en"` on every call so the tests don't depend on the
// CI host's default locale.

import { describe, expect, it } from "vitest";
import { formatRelativeTime, formatRelativeWithAbsolute } from "../src/lib/relative-time";

const NOW = 1_700_000_000_000;

describe("formatRelativeTime", () => {
  it("returns 'just now' for the sub-30-second floor", () => {
    expect(formatRelativeTime(NOW - 5_000, { now: NOW, locale: "en" })).toBe("just now");
    expect(formatRelativeTime(NOW, { now: NOW, locale: "en" })).toBe("just now");
  });

  it("returns 'in a moment' for sub-30-second future", () => {
    expect(formatRelativeTime(NOW + 5_000, { now: NOW, locale: "en" })).toBe("in a moment");
  });

  it("crosses into seconds past the 30s floor", () => {
    // Intl.RelativeTimeFormat in `numeric: "auto"` mode might emit "1 minute ago"
    // for a 45-second delta — the contract here is "produces something with
    // a unit name", not exact text matching across runtimes.
    const result = formatRelativeTime(NOW - 45_000, { now: NOW, locale: "en" });
    expect(result).toMatch(/(second|minute|45s)/);
  });

  it("emits a minutes-scale label between 1m and ~1h", () => {
    const result = formatRelativeTime(NOW - 5 * 60_000, { now: NOW, locale: "en" });
    expect(result).toMatch(/(minute|5m)/);
  });

  it("emits an hours-scale label between 1h and ~1d", () => {
    const result = formatRelativeTime(NOW - 3 * 3600_000, { now: NOW, locale: "en" });
    expect(result).toMatch(/(hour|3h)/);
  });

  it("emits a days-scale label between 1d and ~1w", () => {
    const result = formatRelativeTime(NOW - 3 * 86_400_000, { now: NOW, locale: "en" });
    expect(result).toMatch(/(day|3d)/);
  });

  it("falls back to absolute date past 1 week", () => {
    const result = formatRelativeTime(NOW - 14 * 86_400_000, { now: NOW, locale: "en" });
    // "Oct 30" or similar — should be a short month + day, no "ago"
    expect(result).not.toMatch(/ago/);
    expect(result).toMatch(/[A-Z][a-z]{2}\s\d+/);
  });

  it("includes the year when the absolute date is in a different year", () => {
    // 400 days back from 2023-11-14 lands in 2022.
    const result = formatRelativeTime(NOW - 400 * 86_400_000, { now: NOW, locale: "en" });
    expect(result).toMatch(/\d{4}/);
  });
});

describe("formatRelativeWithAbsolute", () => {
  it("combines the relative form with the locale-formatted absolute time", () => {
    const result = formatRelativeWithAbsolute(NOW - 60_000, { now: NOW, locale: "en" });
    expect(result).toContain("·");
    expect(result.split("·").length).toBe(2);
    // The absolute half should contain a digit (year/time) — generic
    // enough to survive any locale's date-style formatting.
    expect(result.split("·")[1]).toMatch(/\d/);
  });
});
