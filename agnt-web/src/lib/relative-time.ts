// Relative time formatter. Used for row tooltips and any "X ago" UI so
// users skimming a long thread can see at-a-glance how recent something
// is without parsing a full date string. Falls back to absolute formats
// past a week (relative gets less useful past that).
//
// Locale-aware via the i18n store: when available, we use
// `Intl.RelativeTimeFormat` so non-English users get correctly inflected
// strings (e.g. "il y a 2 minutes" in fr). The pure formatter accepts an
// explicit `locale` arg so it can be unit-tested without the store.

import { useI18nStore } from "./i18n";

export interface RelativeTimeOptions {
  /** Reference timestamp (ms since epoch). Defaults to `Date.now()`;
   *  pass a fixed value in tests for determinism. */
  now?: number;
  /** BCP-47 locale tag. Defaults to the live locale from the i18n store. */
  locale?: string;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** "Just now" / "5m ago" / "2h ago" / "3d ago" / absolute "Mon 3:14 PM"
 *  past a week. Negative deltas (future timestamps) flip the wording. */
export function formatRelativeTime(timestamp: number, options: RelativeTimeOptions = {}): string {
  const now = options.now ?? Date.now();
  const locale = options.locale ?? useI18nStore.getState().locale;
  const delta = now - timestamp;
  const abs = Math.abs(delta);
  const future = delta < 0;

  if (abs < 30 * SECOND) return future ? "in a moment" : "just now";

  // Try Intl.RelativeTimeFormat where it makes sense (within a day so the
  // precision matches what the user expects). Past a day we drop down to
  // a compact "3d ago" string — Intl's "3 days ago" can feel clunky in
  // chat tooltips, and "Yesterday" loses the precision after midnight.
  const rtf =
    typeof Intl !== "undefined" && typeof Intl.RelativeTimeFormat === "function"
      ? new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
      : null;

  if (abs < MINUTE) {
    const seconds = Math.round(delta / SECOND);
    return rtf ? rtf.format(-seconds, "second") : compactFallback(seconds, "s");
  }
  if (abs < HOUR) {
    const minutes = Math.round(delta / MINUTE);
    return rtf ? rtf.format(-minutes, "minute") : compactFallback(minutes, "m");
  }
  if (abs < DAY) {
    const hours = Math.round(delta / HOUR);
    return rtf ? rtf.format(-hours, "hour") : compactFallback(hours, "h");
  }
  if (abs < WEEK) {
    const days = Math.round(delta / DAY);
    return rtf ? rtf.format(-days, "day") : compactFallback(days, "d");
  }

  // Past a week: absolute date, locale-aware. We keep it short ("Mar 5")
  // because tooltips in row hover should fit on one line.
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: differentYear(timestamp, now) ? "numeric" : undefined,
  }).format(new Date(timestamp));
}

/** Compact label combining the relative form with the absolute time so
 *  hover tooltips give both — useful when the relative reading is too
 *  loose to act on (e.g. "2h ago" meaning 1h45m or 2h30m). */
export function formatRelativeWithAbsolute(timestamp: number, options: RelativeTimeOptions = {}): string {
  const locale = options.locale ?? useI18nStore.getState().locale;
  const relative = formatRelativeTime(timestamp, options);
  const absolute = new Date(timestamp).toLocaleString(locale);
  return `${relative} · ${absolute}`;
}

function compactFallback(value: number, unit: string): string {
  const n = Math.abs(value);
  if (value <= 0) return `in ${n}${unit}`;
  return `${n}${unit} ago`;
}

function differentYear(a: number, b: number): boolean {
  return new Date(a).getFullYear() !== new Date(b).getFullYear();
}
