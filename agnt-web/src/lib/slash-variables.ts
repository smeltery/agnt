// Tiny variable expander for user-defined slash commands. The token set is
// fixed (no nested expansion, no conditionals, no fallback syntax) — keeps
// the contract small enough that users can predict what `{cwd}` will do
// without consulting docs.
//
// Tokens that don't have a value at expand time are left intact so the user
// can see "this didn't resolve" rather than getting a silent empty string.

export interface SlashVariableContext {
  cwd?: string;
  threadTitle?: string;
  /** Currently-highlighted text in the composer (or empty if no selection). */
  selection?: string;
  /** Reference timestamp — pass a fixed value in tests. */
  now?: Date;
}

const TOKEN_RE = /\{([a-z][a-z0-9_]*)\}/gi;

export function expandSlashVariables(body: string, context: SlashVariableContext): string {
  return body.replace(TOKEN_RE, (match, rawName: string) => {
    const name = rawName.toLowerCase();
    const value = resolve(name, context);
    return value === undefined ? match : value;
  });
}

function resolve(name: string, context: SlashVariableContext): string | undefined {
  switch (name) {
    case "cwd":
      return context.cwd ?? "";
    case "thread":
    case "threadtitle":
      return context.threadTitle ?? "";
    case "selection":
      return context.selection ?? "";
    case "date":
      return formatDate(context.now ?? new Date());
    case "datetime":
      return (context.now ?? new Date()).toISOString();
    case "time":
      return formatTime(context.now ?? new Date());
    default:
      return undefined;
  }
}

function formatDate(date: Date): string {
  // YYYY-MM-DD in local time. ISO would be UTC, which surprises users in
  // negative-offset timezones at the day boundary.
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
