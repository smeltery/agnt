package com.smeltery.agnt.mobile.data

import com.smeltery.agnt.mobile.core.model.SystemNotice
import com.smeltery.agnt.mobile.core.model.SystemNoticeSeverity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * Buffers `system/notice` events for the Snackbar host (parity
 * [agnt-web `useNoticesStore`](agnt-web/src/state/notices-store.ts)).
 *
 * Each enqueued notice schedules a self-dismiss job via [scope]; severity drives
 * the default duration when the bridge doesn't supply `durationMs`. [dismiss] is
 * idempotent. [clear] wipes everything on reconnect / session reset.
 *
 * The scope + nowMillis seams exist so JVM unit tests can drive the timing
 * deterministically without coupling to Android handlers.
 */
class SystemNoticesStore(
    private val scope: CoroutineScope =
        CoroutineScope(Dispatchers.Default + kotlinx.coroutines.SupervisorJob()),
    private val idFactory: () -> String = { UUID.randomUUID().toString() },
) {
    private val _notices = MutableStateFlow<List<SystemNotice>>(emptyList())
    val notices: StateFlow<List<SystemNotice>> = _notices.asStateFlow()

    private val dismissJobs = mutableMapOf<String, Job>()
    private val lock = Any()

    /**
     * Append a notice and schedule auto-dismiss after [durationMsOverride] (when
     * positive) or the severity-based default. Drops payloads with no [title] AND
     * no [message] (web parity) so an empty `tui.toast.show` doesn't add an
     * empty pill to the UI.
     */
    fun enqueue(
        severity: SystemNoticeSeverity,
        title: String?,
        message: String?,
        provider: String?,
        threadId: String?,
        durationMsOverride: Long? = null,
    ): SystemNotice? {
        val trimmedTitle = title?.trim()?.takeIf { it.isNotEmpty() }
        val trimmedMessage = message?.trim()?.takeIf { it.isNotEmpty() }
        if (trimmedTitle == null && trimmedMessage == null) return null

        val notice =
            SystemNotice(
                id = idFactory(),
                severity = severity,
                title = trimmedTitle,
                message = trimmedMessage,
                provider = provider?.trim()?.takeIf { it.isNotEmpty() },
                threadId = threadId?.trim()?.takeIf { it.isNotEmpty() },
            )

        synchronized(lock) {
            _notices.value = _notices.value + notice
        }

        val duration =
            durationMsOverride
                ?.takeIf { it > 0 }
                ?: severity.defaultDurationMs
        val job =
            scope.launch {
                delay(duration)
                dismiss(notice.id)
            }
        synchronized(lock) { dismissJobs[notice.id] = job }
        return notice
    }

    /** No-op when [id] is unknown (timer already fired, etc.). */
    fun dismiss(id: String) {
        synchronized(lock) {
            dismissJobs.remove(id)?.cancel()
            val current = _notices.value
            val next = current.filter { it.id != id }
            if (next.size != current.size) _notices.value = next
        }
    }

    /** Reset on disconnect / session reset. */
    fun clear() {
        synchronized(lock) {
            dismissJobs.values.forEach { it.cancel() }
            dismissJobs.clear()
            _notices.value = emptyList()
        }
    }
}
