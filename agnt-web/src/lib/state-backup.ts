// Export / import the user's IndexedDB blob as a portable JSON file.
//
// Scope:
//   ✓ All `prefs.*` keys (turn flags, theme, sidebar layout, pinned threads,
//     last-visited, custom slash commands, bookmarks, thread colors)
//   ✓ Per-thread message cache (`messages:*`) so a restored backup paints the
//     full timeline without waiting for `thread/read` round-trips
//   ✗ `phoneIdentity` (private Ed25519 key) — moving the keypair would break
//     the trusted-mac registry security model and is out of scope for this
//     export
//   ✗ `relayPairing` / `trustedMacRegistry` — pairing state is bridge-bound
//     and re-pairing is the right migration path for a new browser
//
// File shape:
//   { schemaVersion: 1, exportedAt: <ISO>, kv: Record<string, unknown> }
//
// Restore is additive at the kv level: any key the import provides overwrites
// the local copy; keys the import omits are left alone. Identity / pairing
// keys are skipped on import even if they're present in the file.

import { idb } from "../storage/idb";

export const BACKUP_SCHEMA_VERSION = 1;

const ALLOWED_PREFIXES = ["prefs.", "messages:"] as const;

/** Keys we never export — even if a previous build accidentally wrote them
 *  under one of the allowed prefixes. */
const HARD_BLOCKLIST = new Set<string>(["phoneIdentity", "relayPairing", "trustedMacRegistry"]);

export interface StateBackup {
  schemaVersion: number;
  exportedAt: string;
  kv: Record<string, unknown>;
}

export function isBackupKey(key: string): boolean {
  if (HARD_BLOCKLIST.has(key)) return false;
  return ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export async function buildStateBackup(): Promise<StateBackup> {
  const allKeys = await idb.keys();
  const exportable = allKeys.filter(isBackupKey).sort();
  const kv: Record<string, unknown> = {};
  for (const key of exportable) {
    const value = await idb.get<unknown>(key);
    // `undefined` round-trips as missing in JSON.stringify; storing it as
    // null would mis-restore. Skip the entry entirely instead.
    if (typeof value !== "undefined") kv[key] = value;
  }
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    kv,
  };
}

export interface ApplyBackupResult {
  ok: boolean;
  appliedCount?: number;
  skippedCount?: number;
  reason?: string;
}

export async function applyStateBackup(payload: unknown): Promise<ApplyBackupResult> {
  const parsed = parseStateBackup(payload);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  let appliedCount = 0;
  let skippedCount = 0;
  for (const [key, value] of Object.entries(parsed.backup.kv)) {
    if (!isBackupKey(key)) {
      skippedCount += 1;
      continue;
    }
    await idb.set(key, value);
    appliedCount += 1;
  }
  return { ok: true, appliedCount, skippedCount };
}

export function parseStateBackup(payload: unknown): { ok: true; backup: StateBackup } | { ok: false; reason: string } {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "Backup file is not a JSON object." };
  const obj = payload as Record<string, unknown>;
  const version = obj.schemaVersion;
  if (typeof version !== "number" || version < 1 || version > BACKUP_SCHEMA_VERSION) {
    return { ok: false, reason: `Unsupported backup schema version (got ${String(version)}).` };
  }
  const kv = obj.kv;
  if (!kv || typeof kv !== "object" || Array.isArray(kv)) {
    return { ok: false, reason: "Backup is missing the `kv` object." };
  }
  return {
    ok: true,
    backup: {
      schemaVersion: version,
      exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : "",
      kv: kv as Record<string, unknown>,
    },
  };
}

export function defaultBackupFilename(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `agnt-web-backup-${stamp}.json`;
}

export function downloadBackup(backup: StateBackup, filename: string = defaultBackupFilename()): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
