// User-downloadable diagnostic snapshot for bug reports. Collects the
// session's connection state, recent notice surface, IDB key counts +
// names, latency stats, browser info, and an app-version stamp, all in a
// single JSON file.
//
// Privacy is the dominant design constraint here:
//   ✗ No thread contents
//   ✗ No prompt drafts
//   ✗ No identity-private bits (`phoneIdentity` private key)
//   ✓ Only key NAMES from IDB plus their counts
//   ✓ Pairing identifiers are hashed (`shortHash`) so the report is
//     correlation-safe but not directly impersonation-useful
//
// Keep additive: new fields default to undefined so an older parser still
// reads new exports without crashing.

import { idb } from "../storage/idb";
import { useConnectionStore } from "../state/connection-store";
import { useLatencyStore } from "../state/latency-store";
import { useNoticesStore } from "../state/notices-store";

export const DIAGNOSTIC_SCHEMA_VERSION = 1;

export interface DiagnosticReport {
  schemaVersion: number;
  generatedAt: string;
  app: {
    /** Vite stamps `import.meta.env.MODE`. */
    mode?: string;
  };
  browser: {
    userAgent?: string;
    language?: string;
    platform?: string;
    /** Best-effort screen + window dims for layout-bug context. */
    viewport?: { width: number; height: number };
    online?: boolean;
  };
  connection: {
    statusKind?: string;
    pairing?: {
      relayUrl?: string;
      sessionIdHash?: string;
      macDeviceIdHash?: string;
      shouldForceQrBootstrap?: boolean;
    };
  };
  latency: {
    sampleCount: number;
    medianMs: number | null;
    p95Ms: number | null;
    lastSampleAtMs: number | null;
  };
  notices: Array<{ severity: string; title?: string }>;
  storage: {
    /** Total kv keys in the agnt IDB store. */
    totalKeys: number;
    /** Counts grouped by prefix (`prefs.` / `messages:` / other). */
    byPrefix: Record<string, number>;
    /** A sample of message-cache thread ids (capped at 20) to help debug
     *  which threads are persisted. We hash these so a leaked report
     *  can't be reverse-mapped to thread metadata. */
    persistedThreadIdsHashed: string[];
  };
}

export async function buildDiagnosticReport(): Promise<DiagnosticReport> {
  const connection = useConnectionStore.getState();
  const latency = useLatencyStore.getState();
  const notices = useNoticesStore.getState().notices;
  const allKeys = await idb.keys();

  const byPrefix: Record<string, number> = {};
  const persistedThreadIds: string[] = [];
  for (const key of allKeys) {
    const prefix = pickPrefix(key);
    byPrefix[prefix] = (byPrefix[prefix] ?? 0) + 1;
    if (key.startsWith("messages:") && !key.endsWith("__index")) {
      persistedThreadIds.push(key.slice("messages:".length));
    }
  }

  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    app: {
      mode: typeof import.meta !== "undefined" && import.meta.env ? import.meta.env.MODE : undefined,
    },
    browser: {
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      language: typeof navigator !== "undefined" ? navigator.language : undefined,
      platform: typeof navigator !== "undefined" ? navigator.platform : undefined,
      viewport:
        typeof window !== "undefined"
          ? { width: window.innerWidth, height: window.innerHeight }
          : undefined,
      online: typeof navigator !== "undefined" ? navigator.onLine : undefined,
    },
    connection: {
      statusKind: connection.status.kind,
      pairing: connection.saved
        ? {
            relayUrl: connection.saved.relayUrl,
            sessionIdHash: shortHash(connection.saved.sessionId),
            macDeviceIdHash: shortHash(connection.saved.macDeviceId),
            shouldForceQrBootstrap: connection.saved.shouldForceQrBootstrap,
          }
        : undefined,
    },
    latency: {
      sampleCount: latency.samples.length,
      medianMs: latency.samples.length > 0 ? medianOf(latency.samples) : null,
      p95Ms: latency.samples.length > 0 ? percentileOf(latency.samples, 0.95) : null,
      // The store uses `0` as "never sampled". Normalize that to null in the
      // report so consumers can distinguish "no data" from "sampled at epoch".
      lastSampleAtMs: latency.lastSampleAtMs > 0 ? latency.lastSampleAtMs : null,
    },
    notices: notices.map((notice) => ({ severity: notice.severity, title: notice.title })),
    storage: {
      totalKeys: allKeys.length,
      byPrefix,
      persistedThreadIdsHashed: persistedThreadIds.slice(0, 20).map(shortHash),
    },
  };
}

function pickPrefix(key: string): string {
  if (key.startsWith("prefs.")) return "prefs.*";
  if (key.startsWith("messages:")) return "messages:*";
  return "other";
}

/** Two parallel rolling hashes (djb2 + sdbm) concatenated to 12 hex chars.
 *  Cheap, dependency-free, and good enough to make session/mac ids
 *  correlation-safe — these aren't security boundaries, just bug-report
 *  PII reduction. Two hashes lower the casual-collision probability vs a
 *  single 32-bit value. */
export function shortHash(input: string): string {
  let djb2 = 5381;
  let sdbm = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    djb2 = ((djb2 << 5) + djb2 + code) >>> 0;
    sdbm = (code + (sdbm << 6) + (sdbm << 16) - sdbm) >>> 0;
  }
  // 8 hex from djb2 (32-bit) + first 4 hex from sdbm = 12-char id.
  return djb2.toString(16).padStart(8, "0") + sdbm.toString(16).padStart(8, "0").slice(0, 4);
}

function medianOf(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentileOf(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

export function defaultDiagnosticFilename(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `agnt-web-diagnostic-${stamp}.json`;
}

export function downloadDiagnostic(report: DiagnosticReport, filename: string = defaultDiagnosticFilename()): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
