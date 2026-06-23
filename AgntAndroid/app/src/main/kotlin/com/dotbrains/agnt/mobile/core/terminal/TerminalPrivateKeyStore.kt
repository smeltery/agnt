package com.dotbrains.agnt.mobile.core.terminal

import com.dotbrains.agnt.mobile.core.security.CodexSecureKeys
import com.dotbrains.agnt.mobile.core.security.SecureStore

/**
 * Persists the on-device SSH private key + optional passphrase.
 * Mirrors `AgntTerminalPrivateKeyStore.swift`.
 */
class TerminalPrivateKeyStore(
    private val secureStore: SecureStore,
) {
    fun loadPrivateKey(): String = secureStore.readString(CodexSecureKeys.terminalSshPrivateKey).orEmpty()

    fun savePrivateKey(value: String) {
        secureStore.writeString(CodexSecureKeys.terminalSshPrivateKey, normalize(value))
    }

    fun loadPassphrase(): String = secureStore.readString(CodexSecureKeys.terminalSshPrivateKeyPassphrase).orEmpty()

    fun savePassphrase(value: String) {
        secureStore.writeString(CodexSecureKeys.terminalSshPrivateKeyPassphrase, value)
    }

    fun hasPrivateKey(value: String? = null): Boolean {
        val key = normalize(value ?: loadPrivateKey())
        return key.contains("PRIVATE KEY")
    }

    private fun normalize(value: String): String = value.replace("\r\n", "\n").trim()
}
