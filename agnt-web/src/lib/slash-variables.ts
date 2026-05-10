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
  /** Positional arguments parsed from the user's input after the slash trigger.
   *  `/foo a b c` → `["a", "b", "c"]`. Body bodies that reference `{1}`,
   *  `{2}`, etc. expand to the matching index (1-based to match Cursor's
   *  convention; index 0 would be the slash command itself). Missing
   *  positions expand to the empty string so a partial-arg invocation
   *  doesn't litter the prompt with `{2}`. */
  args?: readonly string[];
}

const TOKEN_RE = /\{([a-z][a-z0-9_]*|[0-9]+)\}/gi;
const ARGUMENTS_RE = /\$ARGUMENTS\b/g;

export function expandSlashVariables(body: string, context: SlashVariableContext): string {
  // `$ARGUMENTS` (Claude Code convention) expands to the joined positional
  // args. Done first so a body using `$ARGUMENTS` still gets `{1}` etc.
  // resolved on the same pass below.
  const args = context.args ?? [];
  let expanded = body.replace(ARGUMENTS_RE, args.join(" "));
  expanded = expanded.replace(TOKEN_RE, (match, rawName: string) => {
    if (/^[0-9]+$/.test(rawName)) {
      const index = Number(rawName);
      if (index <= 0 || !Number.isFinite(index)) return match;
      const value = args[index - 1];
      // Empty string for missing positions: keeps `{1} hello` clean if the
      // user invokes with no args. Leaves the literal `{0}` alone since
      // 1-based indexing has no zeroth slot.
      return value ?? "";
    }
    const value = resolve(rawName.toLowerCase(), context);
    return value === undefined ? match : value;
  });
  return expanded;
}

/** Parse the raw text the user typed after a slash command into argv-like
 *  positional args. Whitespace is the separator; quoted runs (`"foo bar"`
 *  or `'foo bar'`) preserve embedded spaces. Surplus args beyond `{N}`
 *  are kept intact for `$ARGUMENTS` to use. */
export function parseSlashArgs(input: string): string[] {
  const out: string[] = [];
  const trimmed = input.trim();
  if (!trimmed) return out;
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(trimmed)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return out;
}

/** Pull the argument tokens a body references so the composer can warn
 *  the user before they submit a half-filled command. Returns the highest
 *  positional index (or 0 if none) and whether `$ARGUMENTS` is referenced. */
export function describeBodyArgs(body: string): { positional: number; arguments: boolean } {
  let positional = 0;
  for (const match of body.matchAll(TOKEN_RE)) {
    const raw = match[1];
    if (/^[0-9]+$/.test(raw)) {
      const n = Number(raw);
      if (n > positional) positional = n;
    }
  }
  return { positional, arguments: ARGUMENTS_RE.test(body) };
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
