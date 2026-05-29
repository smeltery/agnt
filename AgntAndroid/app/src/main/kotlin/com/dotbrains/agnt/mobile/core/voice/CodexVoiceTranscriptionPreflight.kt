package com.dotbrains.agnt.mobile.core.voice

import com.dotbrains.agnt.mobile.core.error.AgentServiceError

/**
 * Mirrors [CodexVoiceTranscriptionPreflight](CodexMobile/CodexMobile/Services/AgentService+Voice.swift).
 */
data class CodexVoiceTranscriptionPreflight(
    val byteCount: Int,
    val durationSeconds: Double,
) {
    val failureMessage: String?
        get() =
            when {
                durationSeconds > MAX_DURATION_SECONDS ->
                    "Voice clips must be 120 seconds or less."
                byteCount > MAX_BYTE_COUNT ->
                    "Voice clips must be smaller than 10 MB."
                else -> null
            }

    fun validate() {
        val msg = failureMessage ?: return
        throw AgentServiceError.InvalidInput(msg)
    }

    companion object {
        const val MAX_DURATION_SECONDS: Double = 120.0
        const val MAX_BYTE_COUNT: Int = 10 * 1024 * 1024
    }
}
