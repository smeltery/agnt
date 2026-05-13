package com.dotbrains.agnt.mobile.core.terminal

import com.dotbrains.agnt.mobile.core.security.CodexSecureKeys
import com.dotbrains.agnt.mobile.core.security.SecureStore

/**
 * Persists [TerminalProfile] in [SecureStore] (Android Keystore-backed prefs).
 * Mirrors `RemodexTerminalProfileStore.swift`.
 */
class TerminalProfileStore(
    private val secureStore: SecureStore,
) {
    fun load(): TerminalProfile =
        secureStore.readCodable<TerminalProfile>(CodexSecureKeys.terminalSshProfile) ?: TerminalProfile.EMPTY

    fun save(profile: TerminalProfile) {
        secureStore.writeCodable(CodexSecureKeys.terminalSshProfile, profile.normalizedForSave())
    }
}
