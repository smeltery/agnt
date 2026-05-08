// Persisted catalog of user-defined slash commands. Tiny by design — name +
// body pairs only. Validation happens at the entry point (`addCommand`); the
// rest of the app trusts the store contents and lets the slash-commands
// merge function dedupe against built-ins.

import { create } from "zustand";
import { CUSTOM_SLASH_NAME_RE } from "./slash-commands";
import { prefsStore, type CustomSlashCommand } from "../storage/prefs-store";

interface CustomSlashCommandsState {
  hydrated: boolean;
  commands: CustomSlashCommand[];
  hydrate(): Promise<void>;
  addCommand(input: CustomSlashCommand): { ok: true } | { ok: false; reason: string };
  updateCommand(originalName: string, input: CustomSlashCommand): { ok: true } | { ok: false; reason: string };
  removeCommand(name: string): void;
}

export const useCustomSlashCommandsStore = create<CustomSlashCommandsState>((set, get) => ({
  hydrated: false,
  commands: [],

  async hydrate() {
    if (get().hydrated) return;
    const commands = await prefsStore.loadCustomSlashCommands();
    set({ commands, hydrated: true });
  },

  addCommand(input) {
    const validation = validate(input);
    if (!validation.ok) return validation;
    const trimmed: CustomSlashCommand = { name: input.name.trim(), body: input.body };
    if (get().commands.some((command) => command.name === trimmed.name)) {
      return { ok: false, reason: "A command with that name already exists." };
    }
    const next = [...get().commands, trimmed];
    set({ commands: next });
    void prefsStore.saveCustomSlashCommands(next);
    return { ok: true };
  },

  updateCommand(originalName, input) {
    const validation = validate(input);
    if (!validation.ok) return validation;
    const trimmed: CustomSlashCommand = { name: input.name.trim(), body: input.body };
    const list = get().commands;
    const index = list.findIndex((command) => command.name === originalName);
    if (index < 0) return { ok: false, reason: "Original command no longer exists." };
    if (
      trimmed.name !== originalName
      && list.some((command) => command.name === trimmed.name)
    ) {
      return { ok: false, reason: "A command with that name already exists." };
    }
    const next = [...list];
    next[index] = trimmed;
    set({ commands: next });
    void prefsStore.saveCustomSlashCommands(next);
    return { ok: true };
  },

  removeCommand(name) {
    const next = get().commands.filter((command) => command.name !== name);
    if (next.length === get().commands.length) return;
    set({ commands: next });
    void prefsStore.saveCustomSlashCommands(next);
  },
}));

function validate(input: CustomSlashCommand): { ok: true } | { ok: false; reason: string } {
  const name = (input.name ?? "").trim();
  if (!CUSTOM_SLASH_NAME_RE.test(name)) {
    return {
      ok: false,
      reason: "Name must start with a letter and use only lowercase letters, numbers, or hyphens (≤32 chars).",
    };
  }
  if (typeof input.body !== "string" || input.body.length === 0) {
    return { ok: false, reason: "Body can't be empty." };
  }
  if (input.body.length > 4000) {
    return { ok: false, reason: "Body is too long (4000 char max)." };
  }
  return { ok: true };
}
