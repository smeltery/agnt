// Single source of truth for the live connection. UI components subscribe via zustand
// selectors; nobody outside this file touches Connection or pairingStore directly.

import { create } from "zustand";
import {
  Connection,
  ConnectionStatus,
  PairingPayload,
  resolveTrustedSession,
  TrustedSessionResolveError,
} from "../protocol";
import { loadOrCreatePhoneIdentity } from "../storage/identity-store";
import { pairingStore, SavedRelayPairing } from "../storage/pairing-store";
import { useLatencyStore } from "./latency-store";
import { useNoticesStore } from "./notices-store";
import { useThreadsStore } from "./threads-store";

export interface ConnectionState {
  status: ConnectionStatus;
  connection: Connection | null;
  saved: SavedRelayPairing | null;
  bootstrapping: boolean;
  /** True while a Mac-switch is in flight (resolving session + opening new socket). */
  switching: boolean;
  hydrate(): Promise<void>;
  pairWithPayload(payload: PairingPayload): Promise<void>;
  reconnect(): Promise<void>;
  switchMac(targetDeviceId: string): Promise<void>;
  forget(): Promise<void>;
}

// Track the previous status kind so transitions emit at most one disconnect
// toast per drop. Module-scoped so it survives across `connect` calls.
let previousStatusKind: ConnectionStatus["kind"] = "idle";

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  status: { kind: "idle" },
  connection: null,
  saved: null,
  bootstrapping: true,
  switching: false,

  async hydrate() {
    const saved = (await pairingStore.loadRelayPairing()) ?? null;
    set({ saved, bootstrapping: false });
  },

  async pairWithPayload(payload) {
    const saved: SavedRelayPairing = {
      sessionId: payload.sessionId,
      relayUrl: payload.relay,
      macDeviceId: payload.macDeviceId,
      macIdentityPublicKey: payload.macIdentityPublicKey,
      lastAppliedBridgeOutboundSeq: 0,
      shouldForceQrBootstrap: true,
    };
    await pairingStore.saveRelayPairing(saved);
    set({ saved });
    await connect(saved, "qr_bootstrap", set, get);
  },

  async reconnect() {
    const saved = get().saved ?? (await pairingStore.loadRelayPairing());
    if (!saved) return;
    set({ saved });
    const mode = saved.shouldForceQrBootstrap ? "qr_bootstrap" : "trusted_reconnect";
    if (mode === "trusted_reconnect") {
      try {
        const phoneIdentity = await loadOrCreatePhoneIdentity();
        const resolved = await resolveTrustedSession({
          relayUrl: saved.relayUrl,
          macDeviceId: saved.macDeviceId,
          phoneIdentity,
        });
        if (resolved.sessionId !== saved.sessionId) {
          const updated = { ...saved, sessionId: resolved.sessionId, lastAppliedBridgeOutboundSeq: 0 };
          await pairingStore.saveRelayPairing(updated);
          set({ saved: updated });
          await connect(updated, "trusted_reconnect", set, get);
          return;
        }
      } catch (error) {
        const remote = error as TrustedSessionResolveError;
        set({ status: { kind: "error", message: remote.message, code: remote.code } });
        return;
      }
    }
    await connect(saved, mode, set, get);
  },

  async switchMac(targetDeviceId) {
    const current = get().saved;
    if (current?.macDeviceId === targetDeviceId) return;

    const registry = await pairingStore.loadRegistry();
    const target = registry.records[targetDeviceId];
    if (!target) {
      useNoticesStore.getState().enqueue({
        severity: "warn",
        title: "Mac not found",
        message: "This Mac is no longer in the trusted list. Re-pair from its QR code to reconnect.",
        durationMs: 8_000,
      });
      return;
    }

    set({ switching: true, status: { kind: "connecting" } });
    get().connection?.close("switch-mac");
    useLatencyStore.getState().reset();

    const newPairing: SavedRelayPairing = {
      sessionId: target.lastResolvedSessionId ?? "",
      relayUrl: target.relayUrl,
      macDeviceId: target.macDeviceId,
      macIdentityPublicKey: target.macIdentityPublicKey,
      lastAppliedBridgeOutboundSeq: 0,
      shouldForceQrBootstrap: false,
    };

    try {
      await pairingStore.saveRelayPairing(newPairing);
      await pairingStore.setLastTrustedMac(targetDeviceId);
      set({ saved: newPairing });

      const phoneIdentity = await loadOrCreatePhoneIdentity();
      const resolved = await resolveTrustedSession({
        relayUrl: newPairing.relayUrl,
        macDeviceId: newPairing.macDeviceId,
        phoneIdentity,
      });
      const updated: SavedRelayPairing = { ...newPairing, sessionId: resolved.sessionId };
      await pairingStore.saveRelayPairing(updated);
      set({ saved: updated });
      await connect(updated, "trusted_reconnect", set, get);
    } catch (error) {
      const remote = error as TrustedSessionResolveError;
      set({ status: { kind: "error", message: remote.message ?? "Could not resolve trusted session.", code: remote.code } });
    } finally {
      set({ switching: false });
    }
  },

  async forget() {
    get().connection?.close("forget");
    useLatencyStore.getState().reset();
    await pairingStore.clearRelayPairing();
    set({ saved: null, connection: null, status: { kind: "idle" } });
  },
}));

async function connect(
  saved: SavedRelayPairing,
  handshakeMode: "qr_bootstrap" | "trusted_reconnect",
  set: (partial: Partial<ConnectionState>) => void,
  get: () => ConnectionState
): Promise<void> {
  get().connection?.close("reconnect");
  const phoneIdentity = await loadOrCreatePhoneIdentity();
  const connection = new Connection({
    relayUrl: saved.relayUrl,
    sessionId: saved.sessionId,
    macDeviceId: saved.macDeviceId,
    expectedMacIdentityPublicKey: saved.macIdentityPublicKey,
    handshakeMode,
    phoneIdentity,
    lastAppliedBridgeOutboundSeq: saved.lastAppliedBridgeOutboundSeq,
    onStatus(status) {
      set({ status });
      // Emit a one-shot toast on `open → (closed|error)` so users know their
      // typing isn't lost. Drafts already debounce-persist to IndexedDB
      // (Session 19); the toast is the *visible* signal that the local
      // backup exists. Only fires on the transition, not on every
      // closed-state re-emit, and only when there was previously an active
      // session worth losing.
      const previous = previousStatusKind;
      previousStatusKind = status.kind;
      if (previous === "open" && (status.kind === "closed" || status.kind === "error")) {
        useNoticesStore.getState().enqueue({
          severity: "warn",
          title: "Connection lost",
          message: "Your in-progress drafts are saved locally. Reconnect to keep going.",
          durationMs: 8_000,
        });
      }
      if (status.kind === "open") {
        void useThreadsStore.getState().bindToConnection(connection);
        if (handshakeMode === "qr_bootstrap") {
          void pairingStore.saveRelayPairing({ ...saved, shouldForceQrBootstrap: false });
          void pairingStore.upsertTrustedMac({
            macDeviceId: saved.macDeviceId,
            macIdentityPublicKey: saved.macIdentityPublicKey,
            relayUrl: saved.relayUrl,
            lastPairedAt: Date.now(),
            lastUsedAt: Date.now(),
          });
        }
      }
    },
    onBridgeOutboundSeq(seq) {
      void pairingStore.patchBridgeOutboundSeq(seq);
    },
    onLatencySample(_method, milliseconds) {
      useLatencyStore.getState().record(milliseconds);
    },
  });
  set({ connection });
  connection.connect();
}
