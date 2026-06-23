// FILE: AgntTerminalProfileStore.swift
// Purpose: Persists the SSH terminal profile in Keychain-backed app storage.
// Layer: Service
// Exports: AgntTerminalProfileStore
// Depends on: SecureStore, AgntTerminalProfile

import Foundation

enum AgntTerminalProfileStore {
    // Keeps host/key-path configuration with the same Keychain protection as pairing metadata.
    static func load() -> AgntTerminalProfile {
        SecureStore.readCodable(AgntTerminalProfile.self, for: CodexSecureKeys.terminalSSHProfile)
            ?? .empty
    }

    static func save(_ profile: AgntTerminalProfile) {
        SecureStore.writeCodable(profile.normalizedForSave, for: CodexSecureKeys.terminalSSHProfile)
    }
}
