// Read-only account-status surface. Calls `account/status/read` (Codex-only)
// and `getAuthStatus` (other providers) and exposes a normalized snapshot for
// the Settings screen. Full OAuth-style login flow is intentionally deferred —
// it needs cross-tab redirect handling and the iOS app handles it via
// `account/login/openOnMac`, which doesn't translate to the browser cleanly.

import { create } from "zustand";
import { makeLogger } from "../lib/log";
import type { JsonRpcRemoteError } from "../protocol/jsonrpc-client";
import type { Connection } from "../protocol";

const log = makeLogger("account");

export interface HostCapabilitiesSnapshot {
  /** On-device SSH terminal — iOS/Android only; the web client cannot use it. */
  terminal?: boolean;
  /** Bridge-spawned local PTY exposed to the web client (opt-in, off by default). */
  terminalLocal?: boolean;
}

export interface AccountSnapshot {
  providerId?: string;
  loggedIn: boolean;
  authMethod?: string;
  message?: string;
  loginUrl?: string;
  hostCapabilities?: HostCapabilitiesSnapshot;
}

interface State {
  snapshot: AccountSnapshot | null;
  refreshing: boolean;
  bind(connection: Connection): void;
  refresh(): Promise<void>;
  reset(): void;
}

let activeConnection: Connection | null = null;

export const useAccountStore = create<State>((set) => ({
  snapshot: null,
  refreshing: false,
  bind(connection) {
    activeConnection = connection;
    set({ snapshot: null });
  },
  async refresh() {
    if (!activeConnection?.rpc) return;
    set({ refreshing: true });
    try {
      // Try Codex's `account/status/read` first; fall back to the generic
      // `getAuthStatus` shape that Claude/opencode/cursor use.
      const result = await callFirstSupported(activeConnection);
      set({ snapshot: result, refreshing: false });
    } catch (error) {
      log.warn("account refresh failed", error);
      set({ refreshing: false });
    }
  },
  reset() {
    activeConnection = null;
    set({ snapshot: null, refreshing: false });
  },
}));

async function callFirstSupported(connection: Connection): Promise<AccountSnapshot> {
  for (const method of ["account/status/read", "getAuthStatus"]) {
    try {
      const result = await connection.rpc.request<Record<string, unknown>>(method, {});
      return normalizeAccountSnapshot(method, result);
    } catch (error) {
      if (!isMethodNotFound(error)) throw error;
    }
  }
  return { loggedIn: false, message: "managed by the bridge" };
}

function normalizeAccountSnapshot(method: string, raw: Record<string, unknown>): AccountSnapshot {
  return {
    providerId: stringField(raw, "providerId", "provider"),
    loggedIn: Boolean(raw.loggedIn ?? raw.authenticated ?? raw.isAuthenticated),
    authMethod: stringField(raw, "authMethod", "method"),
    message: stringField(raw, "message", "displayMessage"),
    loginUrl: method === "account/status/read" ? stringField(raw, "loginUrl") : undefined,
    hostCapabilities: normalizeHostCapabilities(raw.hostCapabilities),
  };
}

function normalizeHostCapabilities(raw: unknown): HostCapabilitiesSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  return {
    terminal: typeof record.terminal === "boolean" ? record.terminal : undefined,
    terminalLocal: typeof record.terminalLocal === "boolean" ? record.terminalLocal : undefined,
  };
}

function isMethodNotFound(error: unknown): boolean {
  return (error as JsonRpcRemoteError | undefined)?.code === -32601;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
