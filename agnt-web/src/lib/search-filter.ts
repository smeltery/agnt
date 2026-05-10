// Search filter predicate used by the CommandPalette. Centralized here so
// the palette stays focused on rendering and the filter logic can be unit
// tested without spinning up the modal.
//
// All filters are AND-combined: a message must pass every active filter
// to surface as a hit. "any" sentinels short-circuit the corresponding
// check so we don't pay for the comparison when the filter is off.

import type { CodexMessage } from "../models";

export type SearchRoleFilter = "any" | "user" | "assistant";
export type SearchDateFilter = "any" | "24h" | "7d" | "30d";

export interface SearchFilters {
  role: SearchRoleFilter;
  date: SearchDateFilter;
  /** Specific model id to filter on, or `null` for "any model". */
  model: string | null;
  /** Reference timestamp for date filters. Defaults to `Date.now()`; pass
   *  a fixed value in tests so the cutoffs are deterministic. */
  now?: number;
}

const DAY_MS = 86_400_000;

const DATE_WINDOW_MS: Record<SearchDateFilter, number | null> = {
  any: null,
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

/** True when the filters are all at their permissive default. Used by the
 *  palette to decide whether to show the "Filtered" indicator + reset btn. */
export function isFilterDefault(filters: SearchFilters): boolean {
  return filters.role === "any" && filters.date === "any" && filters.model === null;
}

export function defaultFilters(): SearchFilters {
  return { role: "any", date: "any", model: null };
}

/** Pure predicate. Returns true when the message passes every active
 *  filter, false otherwise. Caller still applies the text query separately
 *  — the role / date / model filters are orthogonal to the substring or
 *  fuzzy match. */
export function passesFilters(message: CodexMessage, filters: SearchFilters): boolean {
  if (filters.role !== "any" && message.role !== filters.role) return false;

  const window = DATE_WINDOW_MS[filters.date];
  if (window !== null) {
    const now = filters.now ?? Date.now();
    // `createdAt` is ms-since-epoch; fall back to 0 (always too old) when a
    // record somehow lands without a timestamp. Better to drop it from the
    // filtered view than misclassify it as "recent."
    const ts = typeof message.createdAt === "number" ? message.createdAt : 0;
    if (now - ts > window) return false;
  }

  if (filters.model !== null) {
    const messageModel = readMessageModel(message);
    if (messageModel !== filters.model) return false;
  }

  return true;
}

/** Pluck the model id off whatever shape the bridge stamped on the
 *  message. The reducer doesn't normalize this consistently — some
 *  providers attach `model`, others bury it under metadata — so we try a
 *  small list. Returns null when no model can be resolved (which means
 *  the model filter excludes the row). */
function readMessageModel(message: CodexMessage): string | null {
  const direct = (message as unknown as Record<string, unknown>).model;
  if (typeof direct === "string" && direct) return direct;
  const meta = (message as unknown as Record<string, unknown>).metadata;
  if (meta && typeof meta === "object") {
    const m = (meta as Record<string, unknown>).model;
    if (typeof m === "string" && m) return m;
  }
  return null;
}
