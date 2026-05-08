// Slash-command catalog. Each command knows its label, hint, and how to run
// against the current thread context. The composer renders a filtered palette
// when the user starts a draft with `/`; selecting an entry runs its action
// and clears the draft.
//
// Keeping the catalog as data (rather than hardcoded JSX in the composer)
// means new commands are a single entry to add, and the slash menu's render
// + filter logic stays generic.

import type { CustomSlashCommand } from "../storage/prefs-store";
import type { ThreadsState } from "../state/threads-store";

export interface SlashCommandContext {
  threadId: string;
  threads: ThreadsState;
  closeNewChat?: () => void;
}

export interface SlashCommand {
  /** Trigger token without leading slash, e.g. "compact". */
  name: string;
  /** Short description shown in the palette. */
  description: string;
  /** Optional aliases that also resolve to this command. */
  aliases?: string[];
  /** Returns true when this command can run against the current state. */
  canRun?(context: SlashCommandContext): boolean;
  /** When defined, the composer inserts this text into the draft instead of
   *  invoking `run`. Used by user-defined commands that just expand a snippet. */
  expand?(context: SlashCommandContext): string;
  /** Runs the command. Should be idempotent and not throw. */
  run(context: SlashCommandContext): Promise<void> | void;
}

/** Slug rule for user-defined names — keep it lowercase + `-` so it can't
 *  collide visually with future built-ins or be confused for whitespace. */
export const CUSTOM_SLASH_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * A small, hand-curated set focused on actions users hit often. We stay away
 * from noisy aliases (`/c` for compact would collide with `/clear`) — the
 * filter is permissive enough that prefixes like `/com` already work.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "compact",
    description: "Summarize older turns to free context window space",
    canRun: ({ threadId }) => Boolean(threadId),
    async run({ threadId, threads }) {
      await threads.compactThread(threadId);
    },
  },
  {
    name: "fork",
    description: "Create a new thread starting from this thread's turns",
    canRun: ({ threadId }) => Boolean(threadId),
    async run({ threadId, threads }) {
      await threads.forkThread(threadId);
    },
  },
  {
    name: "archive",
    description: "Move this thread to the archived tab",
    canRun: ({ threadId, threads }) =>
      Boolean(threadId) && threads.threads.some((thread) => thread.id === threadId),
    async run({ threadId, threads }) {
      await threads.archiveThread(threadId);
    },
  },
  {
    name: "unarchive",
    description: "Restore this thread from the archived tab",
    canRun: ({ threadId, threads }) =>
      Boolean(threadId) && threads.archivedThreads.some((thread) => thread.id === threadId),
    async run({ threadId, threads }) {
      await threads.unarchiveThread(threadId);
    },
  },
  {
    name: "stop",
    aliases: ["interrupt"],
    description: "Stop the running turn (same as the chat-header Stop button)",
    canRun: ({ threadId, threads }) => {
      if (!threadId) return false;
      const reducer = threads.reducerStates[threadId];
      return Boolean(reducer?.activeTurnId);
    },
    async run({ threads }) {
      await threads.stopTurn();
    },
  },
];

/** Wraps a user-defined `{name, body}` pair as a SlashCommand whose action is
 *  expanding the body into the composer. Built-ins always win on name
 *  collision — we filter those out at merge time. */
export function buildCustomSlashCommand(custom: CustomSlashCommand): SlashCommand {
  return {
    name: custom.name,
    description: previewSnippet(custom.body) || "(empty snippet)",
    expand: () => custom.body,
    run() {
      // Unused for expand-style commands — the composer routes around `run`
      // when `expand` is set. We keep a noop here so the type stays stable.
    },
  };
}

function previewSnippet(body: string): string {
  const stripped = body.replace(/\s+/g, " ").trim();
  return stripped.length > 80 ? `${stripped.slice(0, 77)}…` : stripped;
}

/**
 * Filter the catalog by a typed query (no leading slash). An empty query
 * returns every runnable command for the current context. Matching is
 * case-insensitive and uses substring on `name` + aliases first, then `name`
 * substring loosely so partial typos still find something.
 *
 * Custom commands appended after built-ins. A custom command whose `name`
 * collides with a built-in is dropped silently — built-ins always win so a
 * typo in user prefs can't hijack `/stop`.
 */
export function filterSlashCommands(
  query: string,
  context: SlashCommandContext,
  customCommands: readonly CustomSlashCommand[] = []
): SlashCommand[] {
  const trimmed = query.trim().toLowerCase();
  const builtinNames = new Set(SLASH_COMMANDS.map((command) => command.name));
  const merged: SlashCommand[] = [
    ...SLASH_COMMANDS,
    ...customCommands
      .filter((custom) => !builtinNames.has(custom.name) && CUSTOM_SLASH_NAME_RE.test(custom.name))
      .map(buildCustomSlashCommand),
  ];
  return merged.filter((command) => {
    if (command.canRun && !command.canRun(context)) return false;
    if (!trimmed) return true;
    if (command.name.toLowerCase().includes(trimmed)) return true;
    if (command.aliases?.some((alias) => alias.toLowerCase().includes(trimmed))) return true;
    return false;
  });
}
