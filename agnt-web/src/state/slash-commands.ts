// Slash-command catalog. Each command knows its label, hint, and how to run
// against the current thread context. The composer renders a filtered palette
// when the user starts a draft with `/`; selecting an entry runs its action
// and clears the draft.
//
// Keeping the catalog as data (rather than hardcoded JSX in the composer)
// means new commands are a single entry to add, and the slash menu's render
// + filter logic stays generic.

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
  /** Runs the command. Should be idempotent and not throw. */
  run(context: SlashCommandContext): Promise<void> | void;
}

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

/**
 * Filter the catalog by a typed query (no leading slash). An empty query
 * returns every runnable command for the current context. Matching is
 * case-insensitive and uses substring on `name` + aliases first, then `name`
 * substring loosely so partial typos still find something.
 */
export function filterSlashCommands(
  query: string,
  context: SlashCommandContext
): SlashCommand[] {
  const trimmed = query.trim().toLowerCase();
  return SLASH_COMMANDS.filter((command) => {
    if (command.canRun && !command.canRun(context)) return false;
    if (!trimmed) return true;
    if (command.name.toLowerCase().includes(trimmed)) return true;
    if (command.aliases?.some((alias) => alias.toLowerCase().includes(trimmed))) return true;
    return false;
  });
}
