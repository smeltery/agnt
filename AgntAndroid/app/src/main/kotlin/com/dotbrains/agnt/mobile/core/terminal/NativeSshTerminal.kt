package com.dotbrains.agnt.mobile.core.terminal

import android.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.KeyType
import net.schmizz.sshj.connection.channel.direct.PTYMode
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.connection.channel.direct.SessionChannel
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.password.PasswordFinder
import net.schmizz.sshj.userauth.password.Resource
import java.io.IOException
import java.io.OutputStream
import java.security.PublicKey
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/**
 * Phone-side SSH client wrapping [SSHClient]. Mirrors `AgntNativeSSHTerminal.swift`.
 * Owns one SSH session at a time; calling [open] tears down any prior session.
 */
class NativeSshTerminal(
    private val knownHostStore: TerminalKnownHostStore,
) {
    sealed class TerminalError(
        message: String,
    ) : Exception(message) {
        object MissingPrivateKey :
            TerminalError("Paste your SSH private key before connecting.")

        object HostKeyChanged :
            TerminalError("The SSH host key changed. Check the host before reconnecting.")

        class UnsupportedPrivateKey(
            reason: String,
        ) : TerminalError("This SSH key type is not supported yet: $reason. Use an Ed25519, ECDSA, or RSA private key.")

        object SessionNotRunning :
            TerminalError("The SSH terminal is not running.")

        class Network(
            message: String,
        ) : TerminalError(message)
    }

    fun interface OutputSink {
        fun onOutput(bytes: ByteArray)
    }

    private data class ActiveSession(
        val id: String,
        val client: SSHClient,
        val session: Session,
        val shell: Session.Shell,
        val output: OutputStream,
        val supervisor: Job,
    )

    private val mutex = Mutex()
    private val active = AtomicReference<ActiveSession?>(null)

    val isRunning: Boolean
        get() = active.get() != null

    /**
     * Establishes a new SSH session, allocates a PTY, and starts the remote shell.
     * Returns once the shell is ready and reading from stdout in the background.
     * @throws TerminalError if connection or auth fails.
     */
    suspend fun open(
        profile: TerminalProfile,
        privateKey: String,
        passphrase: String,
        cols: Int,
        rows: Int,
        scope: CoroutineScope,
        onOutput: OutputSink,
        onFinished: (Throwable?) -> Unit,
    ) {
        val normalizedKey = privateKey.replace("\r\n", "\n").trim()
        if (normalizedKey.isEmpty()) {
            throw TerminalError.MissingPrivateKey
        }

        // Tear down any previous session before opening a new one.
        closeQuietly()

        val sessionId = UUID.randomUUID().toString()
        val supervisor = SupervisorJob(scope.coroutineContext[Job])
        val readerScope = CoroutineScope(scope.coroutineContext + supervisor + Dispatchers.IO)

        val ready = CompletableDeferred<Unit>()

        readerScope.launch {
            val client = SSHClient()
            var session: Session? = null
            var shell: Session.Shell? = null
            var thrown: Throwable? = null
            try {
                client.addHostKeyVerifier(TofuHostKeyVerifier(knownHostStore, profile.host, profile.port))
                client.connectTimeout = 15_000
                client.connect(profile.host, profile.port)

                val keyProvider =
                    runCatching {
                        client.loadKeys(
                            normalizedKey,
                            null,
                            if (passphrase.isEmpty()) null else FixedPassphrase(passphrase),
                        )
                    }.getOrElse { error ->
                        throw TerminalError.UnsupportedPrivateKey(error.message ?: error::class.java.simpleName)
                    }

                client.authPublickey(profile.username, keyProvider)

                val newSession = client.startSession()
                session = newSession
                newSession.allocatePTY(
                    "xterm-256color",
                    cols.coerceAtLeast(1),
                    rows.coerceAtLeast(1),
                    0,
                    0,
                    mapOf(PTYMode.ECHO to 1),
                )
                val newShell = newSession.startShell()
                shell = newShell

                val live =
                    ActiveSession(
                        id = sessionId,
                        client = client,
                        session = newSession,
                        shell = newShell,
                        output = newShell.outputStream,
                        supervisor = supervisor,
                    )
                active.set(live)
                ready.complete(Unit)

                pumpStream(newShell.inputStream, sessionId, onOutput)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                thrown = error
                if (!ready.isCompleted) ready.completeExceptionally(error)
            } finally {
                if (active.compareAndSet(active.get()?.takeIf { it.id == sessionId }, null)) {
                    runCatching { shell?.close() }
                    runCatching { session?.close() }
                    runCatching { client.disconnect() }
                }
                if (ready.isCompleted) {
                    val finalError =
                        when (thrown) {
                            null, is CancellationException -> null
                            else -> thrown
                        }
                    onFinished(finalError)
                }
            }
        }

        try {
            ready.await()
        } catch (error: Throwable) {
            // Map sshj exceptions to our typed errors when possible.
            throw when (error) {
                is TerminalError -> error
                is IOException -> TerminalError.Network(error.message ?: "SSH connection failed.")
                else -> error
            }
        }
    }

    suspend fun write(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        val session = active.get() ?: throw TerminalError.SessionNotRunning
        withContext(Dispatchers.IO) {
            mutex.withLock {
                session.output.write(bytes)
                session.output.flush()
            }
        }
    }

    suspend fun resize(
        cols: Int,
        rows: Int,
    ) {
        val current = active.get() ?: return
        withContext(Dispatchers.IO) {
            runCatching {
                (current.session as? SessionChannel)?.changeWindowDimensions(
                    cols.coerceAtLeast(1),
                    rows.coerceAtLeast(1),
                    0,
                    0,
                )
            }
        }
    }

    suspend fun close() {
        withContext(Dispatchers.IO) { closeQuietly() }
    }

    private fun closeQuietly() {
        val current = active.getAndSet(null) ?: return
        runCatching { current.shell.close() }
        runCatching { current.session.close() }
        runCatching { current.client.disconnect() }
        current.supervisor.cancel()
    }

    private suspend fun pumpStream(
        stream: java.io.InputStream,
        sessionId: String,
        onOutput: OutputSink,
    ) {
        val buffer = ByteArray(4096)
        while (true) {
            val read =
                try {
                    stream.read(buffer)
                } catch (_: IOException) {
                    -1
                }
            if (read <= 0) break
            // Discard if a newer session has taken over.
            if (active.get()?.id != sessionId) break
            onOutput.onOutput(buffer.copyOf(read))
        }
    }

    private class FixedPassphrase(
        passphrase: String,
    ) : PasswordFinder {
        private val chars: CharArray = passphrase.toCharArray()

        override fun reqPassword(resource: Resource<*>?): CharArray = chars.copyOf()

        override fun shouldRetry(resource: Resource<*>?): Boolean = false
    }

    private class TofuHostKeyVerifier(
        private val store: TerminalKnownHostStore,
        private val host: String,
        private val port: Int,
    ) : HostKeyVerifier {
        override fun verify(
            hostname: String?,
            p1: Int,
            key: PublicKey?,
        ): Boolean {
            if (key == null) return false
            val encoded = encodeOpenSshPublicKey(key) ?: return false
            val stored = store.load(host, port)
            return when {
                stored == null -> {
                    store.save(encoded, host, port)
                    true
                }
                stored == encoded -> true
                else -> throw TerminalError.HostKeyChanged
            }
        }

        override fun findExistingAlgorithms(
            hostname: String?,
            p1: Int,
        ): MutableList<String> = mutableListOf()

        private fun encodeOpenSshPublicKey(key: PublicKey): String? =
            runCatching {
                val keyType = KeyType.fromKey(key)
                val buffer = Buffer.PlainBuffer()
                keyType.putPubKeyIntoBuffer(key, buffer)
                val base64 = Base64.encodeToString(buffer.compactData, Base64.NO_WRAP)
                "$keyType $base64"
            }.getOrNull()
    }
}
