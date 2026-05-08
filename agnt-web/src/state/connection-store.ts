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
import { useThreadsStore } from "./threads-store";

export interface ConnectionState {
  status: ConnectionStatus;
  connection: Connection | null;
  saved: SavedRelayPairing | null;
  bootstrapping: boolean;
  hydrate(): Promise<void>;
  pairWithPayload(payload: PairingPayload): Promise<void>;
  reconnect(): Promise<void>;
  forget(): Promise<void>;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  status: { kind: "idle" },
  connection: null,
  saved: null,
  bootstrapping: true,

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

  async forget() {
    get().connection?.close("forget");
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
      if (status.kind === "open") {
        useThreadsStore.getState().bindToConnection(connection);
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
  });
  set({ connection });
  connection.connect();
}
