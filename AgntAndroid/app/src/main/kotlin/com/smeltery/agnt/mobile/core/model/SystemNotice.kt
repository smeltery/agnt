package com.smeltery.agnt.mobile.core.model

/**
 * Toast-style notice surfaced from a `system/notice` JSON-RPC notification
 * (parity with the agnt-web `useNoticesStore`, sourced from opencode's
 * `tui.toast.show` SSE events as proxied by the bridge).
 *
 * The bridge envelope shape is:
 * ```
 * { method: "system/notice", params: {
 *     threadId?: string,
 *     provider?: string,
 *     severity?: "info"|"warn"|"error"|...
 *     title?: string,
 *     message?: string,
 *     durationMs?: number
 * } }
 * ```
 *
 * [id] is generated on the client (the bridge does not supply one) so the
 * store can dedupe + drive per-notice dismiss timers.
 */
data class SystemNotice(
    val id: String,
    val severity: SystemNoticeSeverity,
    val title: String?,
    val message: String?,
    val provider: String?,
    val threadId: String?,
)

enum class SystemNoticeSeverity {
    Info,
    Warn,
    Error,
    ;

    companion object {
        /** Default auto-dismiss duration when the bridge doesn't supply one. */
        val Info_defaultDurationMs: Long = 5_000L
        val Warn_defaultDurationMs: Long = 8_000L
        val Error_defaultDurationMs: Long = 12_000L

        /**
         * Bridge sends arbitrary strings (`"info"`, `"warning"`, `"warn"`,
         * `"error"`, `"danger"`, …). Map to our 3-bucket model, defaulting to
         * Info — parity with `agnt-web/src/state/notices-store.ts:normalizeSeverity`.
         */
        fun fromBridgeValue(raw: String?): SystemNoticeSeverity {
            val value = raw?.trim()?.lowercase().orEmpty()
            return when (value) {
                "warn", "warning" -> Warn
                "error", "danger" -> Error
                else -> Info
            }
        }
    }

    val defaultDurationMs: Long
        get() =
            when (this) {
                Info -> Info_defaultDurationMs
                Warn -> Warn_defaultDurationMs
                Error -> Error_defaultDurationMs
            }
}
