// Persistent relay pairing + trusted-mac registry. Browser equivalent of the iOS
// CodexSecureKeys.{relaySessionId,relayUrl,relayMacDeviceId,relayMacIdentityPublicKey,
// trustedMacRegistry,lastTrustedMacDeviceId,relayLastAppliedBridgeOutboundSeq} group.
//
// Kept dumb: each helper is a single read or write — orchestration lives in connection-state.

import { idb } from "./idb";

export interface SavedRelayPairing {
  sessionId: string;
  relayUrl: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
  lastAppliedBridgeOutboundSeq: number;
  shouldForceQrBootstrap: boolean;
}

export interface TrustedMacRecord {
  macDeviceId: string;
  macIdentityPublicKey: string;
  relayUrl: string;
  displayName?: string;
  lastPairedAt: number;
  lastUsedAt: number;
  lastResolvedSessionId?: string;
  lastResolvedAt?: number;
}

export interface TrustedMacRegistry {
  records: Record<string, TrustedMacRecord>;
  lastTrustedMacDeviceId?: string;
}

const RELAY_KEY = "relayPairing";
const REGISTRY_KEY = "trustedMacRegistry";

const EMPTY_REGISTRY: TrustedMacRegistry = { records: {} };

export const pairingStore = {
  async loadRelayPairing(): Promise<SavedRelayPairing | undefined> {
    return idb.get<SavedRelayPairing>(RELAY_KEY);
  },
  async saveRelayPairing(value: SavedRelayPairing): Promise<void> {
    await idb.set(RELAY_KEY, value);
  },
  async clearRelayPairing(): Promise<void> {
    await idb.remove(RELAY_KEY);
  },
  async patchBridgeOutboundSeq(seq: number): Promise<void> {
    const existing = await idb.get<SavedRelayPairing>(RELAY_KEY);
    if (!existing) return;
    if (seq <= existing.lastAppliedBridgeOutboundSeq) return;
    await idb.set(RELAY_KEY, { ...existing, lastAppliedBridgeOutboundSeq: seq });
  },

  async loadRegistry(): Promise<TrustedMacRegistry> {
    return (await idb.get<TrustedMacRegistry>(REGISTRY_KEY)) ?? { ...EMPTY_REGISTRY };
  },
  async saveRegistry(registry: TrustedMacRegistry): Promise<void> {
    await idb.set(REGISTRY_KEY, registry);
  },
  async upsertTrustedMac(record: TrustedMacRecord): Promise<TrustedMacRegistry> {
    const registry = await pairingStore.loadRegistry();
    registry.records[record.macDeviceId] = record;
    registry.lastTrustedMacDeviceId = record.macDeviceId;
    await pairingStore.saveRegistry(registry);
    return registry;
  },
  async forgetTrustedMac(macDeviceId: string): Promise<TrustedMacRegistry> {
    const registry = await pairingStore.loadRegistry();
    delete registry.records[macDeviceId];
    if (registry.lastTrustedMacDeviceId === macDeviceId) {
      registry.lastTrustedMacDeviceId = Object.keys(registry.records)[0];
    }
    await pairingStore.saveRegistry(registry);
    return registry;
  },
};
