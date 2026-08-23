package com.smeltery.agnt.mobile.core.terminal

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import java.util.UUID

/**
 * Owns the on-device SSH terminal state and routes UI calls into [NativeSshTerminal].
 * Mirrors the Swift `AgentService+Terminal` extension. Multiple concurrent terminals
 * are supported (terminal ids `term-1`, `term-2`, …).
 */
class TerminalController(
    private val profileStore: TerminalProfileStore,
    private val privateKeyStore: TerminalPrivateKeyStore,
    private val knownHostStore: TerminalKnownHostStore,
    private val ioScope: CoroutineScope =
        CoroutineScope(Dispatchers.IO + SupervisorJob()),
) {
    private val _snapshots =
        MutableStateFlow<Map<String, TerminalSnapshot>>(
            mapOf(
                TerminalSnapshot.DEFAULT_TERMINAL_ID to TerminalSnapshot.idle(TerminalSnapshot.DEFAULT_TERMINAL_ID),
            ),
        )
    val snapshots: StateFlow<Map<String, TerminalSnapshot>> = _snapshots

    /** Per-chunk output events for callers (e.g. xterm.js bridge) that need to forward incremental writes. */
    data class OutputEvent(
        val terminalId: String,
        val instanceId: String,
        val bytes: ByteArray,
    ) {
        override fun equals(other: Any?): Boolean =
            other is OutputEvent &&
                terminalId == other.terminalId &&
                instanceId == other.instanceId &&
                bytes.contentEquals(other.bytes)

        override fun hashCode(): Int = (terminalId.hashCode() * 31 + instanceId.hashCode()) * 31 + bytes.contentHashCode()
    }

    private val _outputEvents =
        MutableSharedFlow<OutputEvent>(
            extraBufferCapacity = 64,
            onBufferOverflow = BufferOverflow.DROP_OLDEST,
        )
    val outputEvents: SharedFlow<OutputEvent> = _outputEvents

    private val terminals = mutableMapOf<String, NativeSshTerminal>()
    private val terminalsLock = Any()

    fun snapshot(terminalId: String): TerminalSnapshot = _snapshots.value[terminalId] ?: TerminalSnapshot.idle(terminalId)

    fun knownSnapshots(): List<TerminalSnapshot> {
        val map = _snapshots.value.toMutableMap()
        map.putIfAbsent(
            TerminalSnapshot.DEFAULT_TERMINAL_ID,
            TerminalSnapshot.idle(TerminalSnapshot.DEFAULT_TERMINAL_ID),
        )
        return map.values.sortedBy { it.terminalId.removePrefix("term-").toIntOrNull() ?: Int.MAX_VALUE }
    }

    fun loadProfile(): TerminalProfile = profileStore.load()

    fun saveProfile(profile: TerminalProfile) {
        profileStore.save(profile)
    }

    fun loadPrivateKey(): String = privateKeyStore.loadPrivateKey()

    fun savePrivateKey(value: String) {
        privateKeyStore.savePrivateKey(value)
    }

    fun loadPassphrase(): String = privateKeyStore.loadPassphrase()

    fun savePassphrase(value: String) {
        privateKeyStore.savePassphrase(value)
    }

    fun hasPrivateKey(value: String? = null): Boolean = privateKeyStore.hasPrivateKey(value)

    fun resetKnownHost(
        host: String,
        port: Int,
    ) {
        knownHostStore.delete(host, port)
    }

    /**
     * Opens (or restarts) the SSH session for [terminalId].
     * @throws NativeSshTerminal.TerminalError if connection or auth fails.
     */
    suspend fun openTerminal(
        terminalId: String = TerminalSnapshot.DEFAULT_TERMINAL_ID,
        profile: TerminalProfile,
        cols: Int,
        rows: Int,
    ) {
        val normalized = profile.normalizedForSave()
        val instanceId = UUID.randomUUID().toString()
        profileStore.save(normalized)

        setSnapshot(
            terminalId,
            TerminalSnapshot(
                terminalId = terminalId,
                instanceId = instanceId,
                status = TerminalStatus.Starting,
                bufferData = ByteArray(0),
                cwd = normalized.cwd,
                cols = cols,
                rows = rows,
                errorMessage = null,
                resizeSupported = true,
            ),
        )

        val terminal = nativeTerminal(terminalId)
        val privateKey = privateKeyStore.loadPrivateKey()
        val passphrase = privateKeyStore.loadPassphrase()

        try {
            terminal.open(
                profile = normalized,
                privateKey = privateKey,
                passphrase = passphrase,
                cols = cols,
                rows = rows,
                scope = ioScope,
                onOutput = { bytes ->
                    if (isCurrentInstance(terminalId, instanceId)) {
                        updateSnapshot(terminalId) { it.appendingOutput(bytes) }
                        _outputEvents.tryEmit(OutputEvent(terminalId, instanceId, bytes))
                    }
                },
                onFinished = { error ->
                    if (!isCurrentInstance(terminalId, instanceId)) return@open
                    updateSnapshot(terminalId) { current ->
                        if (error != null) {
                            current.copy(
                                status = TerminalStatus.Error,
                                errorMessage = error.message ?: error::class.java.simpleName,
                            )
                        } else if (current.status == TerminalStatus.Running ||
                            current.status == TerminalStatus.Starting
                        ) {
                            current.copy(status = TerminalStatus.Exited)
                        } else {
                            current
                        }
                    }
                },
            )
            // Reaching here means the shell is up and the reader loop is running.
            if (isCurrentInstance(terminalId, instanceId)) {
                updateSnapshot(terminalId) {
                    it.copy(status = TerminalStatus.Running, errorMessage = null, resizeSupported = true)
                }
                if (normalized.cwd.isNotEmpty()) {
                    val cd = "cd '${normalized.cwd.replace("'", "'\\''")}'\n"
                    runCatching { terminal.write(cd.toByteArray(Charsets.UTF_8)) }
                }
            }
        } catch (error: Throwable) {
            if (isCurrentInstance(terminalId, instanceId)) {
                updateSnapshot(terminalId) {
                    it.copy(
                        status = TerminalStatus.Error,
                        errorMessage = error.message ?: error::class.java.simpleName,
                    )
                }
            }
            throw error
        }
    }

    suspend fun writeInput(
        terminalId: String = TerminalSnapshot.DEFAULT_TERMINAL_ID,
        bytes: ByteArray,
    ) {
        if (bytes.isEmpty()) return
        nativeTerminal(terminalId).write(bytes)
    }

    suspend fun resize(
        terminalId: String = TerminalSnapshot.DEFAULT_TERMINAL_ID,
        cols: Int,
        rows: Int,
    ) {
        updateSnapshot(terminalId) { it.copy(cols = cols, rows = rows) }
        if (snapshot(terminalId).status != TerminalStatus.Running) return
        nativeTerminal(terminalId).resize(cols, rows)
    }

    fun clearBuffer(terminalId: String = TerminalSnapshot.DEFAULT_TERMINAL_ID) {
        updateSnapshot(terminalId) { it.copy(bufferData = ByteArray(0)) }
    }

    suspend fun changeWorkingDirectory(
        terminalId: String = TerminalSnapshot.DEFAULT_TERMINAL_ID,
        cwd: String,
    ) {
        val trimmed = cwd.trim()
        if (trimmed.isEmpty()) return
        updateSnapshot(terminalId) { it.copy(cwd = trimmed) }
        val current = profileStore.load().copy(cwd = trimmed)
        profileStore.save(current)
        if (snapshot(terminalId).status != TerminalStatus.Running) return
        val command = "cd '${trimmed.replace("'", "'\\''")}'\n"
        nativeTerminal(terminalId).write(command.toByteArray(Charsets.UTF_8))
    }

    suspend fun closeTerminal(terminalId: String = TerminalSnapshot.DEFAULT_TERMINAL_ID) {
        nativeTerminal(terminalId).close()
        updateSnapshot(terminalId) { it.copy(status = TerminalStatus.Closed, errorMessage = null) }
    }

    private fun isCurrentInstance(
        terminalId: String,
        instanceId: String,
    ): Boolean = snapshot(terminalId).instanceId == instanceId

    private fun nativeTerminal(terminalId: String): NativeSshTerminal =
        synchronized(terminalsLock) {
            terminals.getOrPut(terminalId) { NativeSshTerminal(knownHostStore) }
        }

    private fun setSnapshot(
        terminalId: String,
        snapshot: TerminalSnapshot,
    ) {
        _snapshots.update { it + (terminalId to snapshot) }
    }

    private fun updateSnapshot(
        terminalId: String,
        mutate: (TerminalSnapshot) -> TerminalSnapshot,
    ) {
        _snapshots.update { current ->
            val existing = current[terminalId] ?: TerminalSnapshot.idle(terminalId)
            current + (terminalId to mutate(existing))
        }
    }
}
