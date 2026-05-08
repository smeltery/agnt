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

export interface SidebarPreferences {
  tab?: SidebarTabPreference;
  query?: string;
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
