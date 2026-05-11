// Persistent client-side preferences. Plays the role iOS UserDefaults does for
// non-sensitive values: per-turn flag picks (model / reasoning effort /
// permission mode / plan mode), so picking "claude-sonnet-4 + medium" once
// survives a page reload.
//
// Keep the schema flat and additive. New fields default to undefined so
// reading an older blob still works.

import { idb } from "./idb";

export interface PersistedTurnFlags {
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
  planMode?: boolean;
}

export type ThemePreference = "auto" | "light" | "dark";

export type SidebarTabPreference = "live" | "archived";

export type SidebarDensity = "comfortable" | "compact";

export type SidebarGroupMode = "recency" | "project";

export interface SidebarPreferences {
  tab?: SidebarTabPreference;
  query?: string;
  /** Recency-group ids the user has collapsed (Today / Yesterday / This week
   *  / Earlier / Pinned / Archived). Persisted; absent groups render expanded. */
  collapsedGroups?: string[];
  /** Row density. `compact` shrinks padding + font for users with many threads. */
  density?: SidebarDensity;
  /** Grouping axis. `recency` (default) uses Today / Yesterday / …; `project`
   *  buckets by `thread.cwd` so users working across many repos can scan one
   *  codebase at a time. */
  groupBy?: SidebarGroupMode;
}

/** "auto" = follow platform permission; "on" = always notify when granted;
 *  "off" = never notify even when granted. */
export type NotificationsPreference = "auto" | "on" | "off";

const TURN_FLAGS_KEY = "prefs.turnFlags";
const THEME_KEY = "prefs.theme";
const SIDEBAR_KEY = "prefs.sidebar";
const PINNED_THREADS_KEY = "prefs.pinnedThreadIds";
const NOTIFICATIONS_KEY = "prefs.notifications";
const LAST_VISITED_KEY = "prefs.lastVisitedByThread";
const CUSTOM_SLASH_KEY = "prefs.customSlashCommands";
const BOOKMARKS_KEY = "prefs.bookmarksByThread";
const THREAD_COLORS_KEY = "prefs.threadColors";
const TURN_WEBHOOK_KEY = "prefs.turnWebhook";
const SAVED_SEARCHES_KEY = "prefs.savedSearches";
const RECENT_SEARCHES_KEY = "prefs.recentSearches";
const THREAD_OVERRIDES_KEY = "prefs.threadOverrides";
const LOCALE_KEY = "prefs.locale";
const MUTED_THREADS_KEY = "prefs.mutedThreadIds";
const SOUND_VOLUME_KEY = "prefs.soundVolume";
const HIGH_CONTRAST_KEY = "prefs.highContrast";

/** Per-thread override of the global turn flags. Anything left undefined
 *  falls back to the global pick from `state/threads-store:turnFlags`. */
export interface ThreadOverride {
  systemPrompt?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface TurnWebhookPreference {
  /** Absolute https/http URL to POST to on turn end. Empty when unset. */
  url: string;
  /** Master switch — when off, the URL is remembered but no requests fire. */
  enabled: boolean;
}

/** Fixed palette — keeping it small so the picker stays compact and the
 *  color set survives the light/dark theme swap (the colors were chosen
 *  to render distinctly against both backgrounds). */
export const THREAD_COLOR_VALUES = ["red", "orange", "yellow", "green", "blue", "purple"] as const;
export type ThreadColor = typeof THREAD_COLOR_VALUES[number];

export interface CustomSlashCommand {
  /** Unique slug — what the user types after `/`. Must match the slug regex. */
  name: string;
  /** Body inserted into the composer when the command runs. */
  body: string;
}

export const prefsStore = {
  async loadTurnFlags(): Promise<PersistedTurnFlags> {
    return (await idb.get<PersistedTurnFlags>(TURN_FLAGS_KEY)) ?? {};
  },
  async saveTurnFlags(flags: PersistedTurnFlags): Promise<void> {
    await idb.set(TURN_FLAGS_KEY, flags);
  },
  async clearTurnFlags(): Promise<void> {
    await idb.remove(TURN_FLAGS_KEY);
  },
  async loadTheme(): Promise<ThemePreference> {
    const raw = await idb.get<ThemePreference>(THEME_KEY);
    return raw === "light" || raw === "dark" || raw === "auto" ? raw : "auto";
  },
  async saveTheme(theme: ThemePreference): Promise<void> {
    await idb.set(THEME_KEY, theme);
  },
  async loadSidebar(): Promise<SidebarPreferences> {
    return (await idb.get<SidebarPreferences>(SIDEBAR_KEY)) ?? {};
  },
  async saveSidebar(prefs: SidebarPreferences): Promise<void> {
    await idb.set(SIDEBAR_KEY, prefs);
  },
  async loadPinnedThreadIds(): Promise<string[]> {
    const raw = await idb.get<string[]>(PINNED_THREADS_KEY);
    return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
  },
  async savePinnedThreadIds(ids: string[]): Promise<void> {
    await idb.set(PINNED_THREADS_KEY, ids);
  },
  async loadNotifications(): Promise<NotificationsPreference> {
    const raw = await idb.get<NotificationsPreference>(NOTIFICATIONS_KEY);
    return raw === "on" || raw === "off" || raw === "auto" ? raw : "auto";
  },
  async saveNotifications(preference: NotificationsPreference): Promise<void> {
    await idb.set(NOTIFICATIONS_KEY, preference);
  },
  async loadLastVisited(): Promise<Record<string, number>> {
    const raw = await idb.get<Record<string, number>>(LAST_VISITED_KEY);
    if (!raw || typeof raw !== "object") return {};
    // Defensive: drop non-numeric values left over from older shapes.
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  },
  async saveLastVisited(map: Record<string, number>): Promise<void> {
    await idb.set(LAST_VISITED_KEY, map);
  },
  async loadCustomSlashCommands(): Promise<CustomSlashCommand[]> {
    const raw = await idb.get<CustomSlashCommand[]>(CUSTOM_SLASH_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (entry): entry is CustomSlashCommand =>
        Boolean(entry) && typeof entry.name === "string" && typeof entry.body === "string"
    );
  },
  async saveCustomSlashCommands(commands: CustomSlashCommand[]): Promise<void> {
    await idb.set(CUSTOM_SLASH_KEY, commands);
  },
  async loadBookmarks(): Promise<Record<string, string[]>> {
    const raw = await idb.get<Record<string, string[]>>(BOOKMARKS_KEY);
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, string[]> = {};
    for (const [threadId, ids] of Object.entries(raw)) {
      if (!Array.isArray(ids)) continue;
      const filtered = ids.filter((value): value is string => typeof value === "string");
      if (filtered.length > 0) out[threadId] = filtered;
    }
    return out;
  },
  async saveBookmarks(map: Record<string, string[]>): Promise<void> {
    await idb.set(BOOKMARKS_KEY, map);
  },
  async loadSavedSearches(): Promise<string[]> {
    const raw = await idb.get<string[]>(SAVED_SEARCHES_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  },
  async saveSavedSearches(queries: string[]): Promise<void> {
    await idb.set(SAVED_SEARCHES_KEY, queries);
  },
  async loadRecentSearches(): Promise<string[]> {
    const raw = await idb.get<string[]>(RECENT_SEARCHES_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  },
  async saveRecentSearches(queries: string[]): Promise<void> {
    await idb.set(RECENT_SEARCHES_KEY, queries);
  },
  async loadThreadOverrides(): Promise<Record<string, ThreadOverride>> {
    const raw = await idb.get<Record<string, ThreadOverride>>(THREAD_OVERRIDES_KEY);
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, ThreadOverride> = {};
    for (const [threadId, override] of Object.entries(raw)) {
      if (!override || typeof override !== "object") continue;
      const cleaned: ThreadOverride = {};
      if (typeof override.systemPrompt === "string") cleaned.systemPrompt = override.systemPrompt;
      if (typeof override.model === "string") cleaned.model = override.model;
      if (typeof override.reasoningEffort === "string") cleaned.reasoningEffort = override.reasoningEffort;
      // Drop entries that ended up empty so saved blobs don't grow forever.
      if (Object.keys(cleaned).length > 0) out[threadId] = cleaned;
    }
    return out;
  },
  async saveThreadOverrides(map: Record<string, ThreadOverride>): Promise<void> {
    await idb.set(THREAD_OVERRIDES_KEY, map);
  },
  async loadLocale(): Promise<string | undefined> {
    const raw = await idb.get<string>(LOCALE_KEY);
    return typeof raw === "string" && raw.trim() ? raw : undefined;
  },
  async saveLocale(locale: string): Promise<void> {
    await idb.set(LOCALE_KEY, locale);
  },
  async loadMutedThreadIds(): Promise<string[]> {
    const raw = await idb.get<string[]>(MUTED_THREADS_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  },
  async saveMutedThreadIds(ids: string[]): Promise<void> {
    // Dedup before persisting so a chatty toggle path can't grow the
    // blob unbounded. Sort for cheap-equality comparisons in tests.
    const unique = Array.from(new Set(ids.filter((id) => typeof id === "string" && id.trim().length > 0)));
    unique.sort();
    await idb.set(MUTED_THREADS_KEY, unique);
  },
  async loadSoundVolume(): Promise<number> {
    // 0..1 scalar applied to the WebAudio gain envelope. 0 = silent
    // (the default — users opt in via Settings); ~0.3 is a comfortable
    // chime level that won't startle headphone users.
    const raw = await idb.get<number>(SOUND_VOLUME_KEY);
    if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
    return Math.max(0, Math.min(1, raw));
  },
  async saveSoundVolume(volume: number): Promise<void> {
    const clamped = Math.max(0, Math.min(1, volume));
    await idb.set(SOUND_VOLUME_KEY, clamped);
  },
  async loadHighContrast(): Promise<boolean> {
    return Boolean(await idb.get<boolean>(HIGH_CONTRAST_KEY));
  },
  async saveHighContrast(enabled: boolean): Promise<void> {
    await idb.set(HIGH_CONTRAST_KEY, Boolean(enabled));
  },
  async loadTurnWebhook(): Promise<TurnWebhookPreference> {
    const raw = await idb.get<TurnWebhookPreference>(TURN_WEBHOOK_KEY);
    if (!raw || typeof raw !== "object") return { url: "", enabled: false };
    return {
      url: typeof raw.url === "string" ? raw.url : "",
      enabled: Boolean(raw.enabled),
    };
  },
  async saveTurnWebhook(pref: TurnWebhookPreference): Promise<void> {
    await idb.set(TURN_WEBHOOK_KEY, pref);
  },
  async loadThreadColors(): Promise<Record<string, ThreadColor>> {
    const raw = await idb.get<Record<string, string>>(THREAD_COLORS_KEY);
    if (!raw || typeof raw !== "object") return {};
    const valid = new Set<string>(THREAD_COLOR_VALUES);
    const out: Record<string, ThreadColor> = {};
    for (const [threadId, color] of Object.entries(raw)) {
      if (typeof color === "string" && valid.has(color)) out[threadId] = color as ThreadColor;
    }
    return out;
  },
  async saveThreadColors(map: Record<string, ThreadColor>): Promise<void> {
    await idb.set(THREAD_COLORS_KEY, map);
  },
};

export function applyThemeToDocument(theme: ThemePreference): void {
  if (typeof document === "undefined") return;
  // "auto" means defer to prefers-color-scheme. We mark that by removing the
  // attribute entirely so the @media block in global.css governs.
  if (theme === "auto") {
    document.documentElement.removeAttribute("data-theme");
    return;
  }
  document.documentElement.dataset.theme = theme;
}

/** Toggle the `data-contrast="high"` attribute. The CSS layers
 *  high-contrast overrides on top of the active light/dark theme so
 *  the user gets bumped border weights + text contrast in either
 *  palette. Removing the attribute returns to the default contrast. */
export function applyHighContrastToDocument(enabled: boolean): void {
  if (typeof document === "undefined") return;
  if (enabled) document.documentElement.dataset.contrast = "high";
  else document.documentElement.removeAttribute("data-contrast");
}
