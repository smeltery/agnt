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

const TURN_FLAGS_KEY = "prefs.turnFlags";

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
};
