package com.dotbrains.agnt.mobile.core.terminal

import com.dotbrains.agnt.mobile.core.security.CodexSecureKeys
import com.dotbrains.agnt.mobile.core.security.SecureStore

/**
 * Trust-on-first-use SSH host key registry.
 * Mirrors `RemodexSSHKnownHostStore.swift`.
 */
class TerminalKnownHostStore(
    private val secureStore: SecureStore,
) {
    fun load(
        host: String,
        port: Int,
    ): String? = secureStore.readString(storageKey(host, port))

    fun save(
        hostKey: String,
        host: String,
        port: Int,
    ) {
        secureStore.writeString(storageKey(host, port), hostKey)
    }

    fun delete(
        host: String,
        port: Int,
    ) {
        secureStore.deleteValue(storageKey(host, port))
    }

    private fun storageKey(
        host: String,
        port: Int,
    ): String {
        val normalized = host.trim().lowercase()
        return "${CodexSecureKeys.terminalSshKnownHostPrefix}.$normalized:$port"
    }
}
