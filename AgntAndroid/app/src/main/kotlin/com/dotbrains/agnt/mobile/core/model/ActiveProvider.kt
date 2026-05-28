package com.dotbrains.agnt.mobile.core.model

/**
 * Identifies which coding-agent backend the bridge is brokering for the current session.
 *
 * The bridge publishes the active provider id on the `initialize` response (warm path) so
 * the Android client can gate Codex-only affordances (voice transcription, account login,
 * structured-JSON thread/generateTitle) pre-emptively instead of waiting for the bridge to
 * reply with `-32601` / "managed externally" and tearing down state after the fact.
 *
 * `unknown` is the safe default before the initialize response arrives or when the bridge
 * is older than the providerId-broadcast change. In `unknown`, UI surfaces should NOT
 * pre-emptively hide their affordances — the existing fail-once-then-hide fallback (e.g.
 * `bridgeSupportsVoiceTranscription`) covers the gap until the next reconnect.
 */
enum class ActiveProvider(val id: String) {
    Codex("codex"),
    Claude("claude"),
    Opencode("opencode"),
    Cursor("cursor"),

    /** Bridge has not yet (or did not) publish a provider id for this session. */
    Unknown(""),
    ;

    val isCodex: Boolean get() = this == Codex

    companion object {
        /**
         * Parse a provider id received from the bridge. Trims, lowercases, and falls back
         * to [Unknown] on empty/unrecognized values so old bridges (no providerId on
         * initialize) don't accidentally light up gates.
         */
        fun fromBridgeId(raw: String?): ActiveProvider {
            val normalized = raw?.trim()?.lowercase().orEmpty()
            if (normalized.isEmpty()) return Unknown
            return entries.firstOrNull { it.id == normalized } ?: Unknown
        }
    }
}
