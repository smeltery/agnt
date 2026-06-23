package com.dotbrains.agnt.mobile.core.terminal

import kotlinx.serialization.Serializable

/**
 * SSH connection profile persisted in [com.dotbrains.agnt.mobile.core.security.SecureStore].
 * Mirrors `AgntTerminalProfile` in `AgntMobile/AgntMobile/Services/Terminal/AgntTerminalModels.swift`.
 */
@Serializable
data class TerminalProfile(
    val host: String = "",
    val username: String = "",
    val port: Int = DEFAULT_PORT,
    val cwd: String = "",
    val nickname: String = "",
) {
    val connectionString: String
        get() {
            val trimmedHost = host.trim()
            val trimmedUser = username.trim()
            val portSuffix = if (port == DEFAULT_PORT) "" else ":$port"
            return if (trimmedUser.isEmpty()) {
                "$trimmedHost$portSuffix"
            } else {
                "$trimmedUser@$trimmedHost$portSuffix"
            }
        }

    val displayTarget: String
        get() {
            val trimmedNickname = nickname.trim()
            if (trimmedNickname.isNotEmpty()) return trimmedNickname
            val trimmedHost = host.trim()
            val trimmedUser = username.trim()
            return if (trimmedUser.isEmpty()) {
                trimmedHost.ifEmpty { "SSH host" }
            } else {
                "$trimmedUser@$trimmedHost"
            }
        }

    fun normalizedForSave(): TerminalProfile =
        copy(
            host = host.trim(),
            username = username.trim(),
            port = port.coerceIn(1, 65_535),
            cwd = cwd.trim(),
            nickname = nickname.trim(),
        )

    fun applyingPreferredWorkingDirectoryOverride(workingDirectory: String?): TerminalProfile {
        val trimmed = workingDirectory?.trim().orEmpty()
        if (trimmed.isEmpty()) return this
        return copy(cwd = trimmed)
    }

    fun applyingConnectionString(value: String): TerminalProfile {
        var raw = value.trim()
        if (raw.startsWith("ssh ")) {
            raw = raw.removePrefix("ssh ").trim()
        }
        if (raw.isEmpty()) return this

        val atIndex = raw.indexOf('@')
        return if (atIndex >= 0) {
            val user = raw.substring(0, atIndex)
            val rest = raw.substring(atIndex + 1)
            applyHostAndPort(rest).copy(username = user)
        } else {
            applyHostAndPort(raw)
        }
    }

    private fun applyHostAndPort(value: String): TerminalProfile {
        val colonIndex = value.indexOf(':')
        return if (colonIndex >= 0) {
            val parsedPort = value.substring(colonIndex + 1).toIntOrNull()
            copy(
                host = value.substring(0, colonIndex),
                port = parsedPort?.coerceIn(1, 65_535) ?: port,
            )
        } else {
            copy(host = value)
        }
    }

    companion object {
        const val DEFAULT_PORT = 22
        val EMPTY = TerminalProfile()
    }
}
