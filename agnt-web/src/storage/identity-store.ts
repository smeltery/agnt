// Persistent phone identity (long-lived Ed25519 keypair + UUID device id).
// Browser equivalent of CodexSecureKeys.phoneIdentityState.
//
// SECURITY NOTE: IndexedDB is not as strong a vault as iOS Keychain — a malicious
// extension or XSS could exfiltrate the key. We document this in deployment guidance
// and recommend serving agnt-web from a private origin (Tailscale, VPN, basic-auth).

import { generatePhoneIdentity, type PhoneIdentity } from "../crypto";
import { idb } from "./idb";

const KEY = "phoneIdentity";

export async function loadOrCreatePhoneIdentity(): Promise<PhoneIdentity> {
  const existing = await idb.get<PhoneIdentity>(KEY);
  if (existing && existing.phoneDeviceId && existing.phoneIdentityPrivateKey && existing.phoneIdentityPublicKey) {
    return existing;
  }
  const fresh = generatePhoneIdentity();
  await idb.set(KEY, fresh);
  return fresh;
}

export async function resetPhoneIdentity(): Promise<void> {
  await idb.remove(KEY);
}
