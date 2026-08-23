package com.smeltery.agnt.mobile.core.voice

import com.smeltery.agnt.mobile.core.error.AgentServiceError
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class CodexVoiceTranscriptionPreflightTest {
    @Test
    fun rejectsOversizedClip() {
        val preflight =
            CodexVoiceTranscriptionPreflight(
                byteCount = CodexVoiceTranscriptionPreflight.MAX_BYTE_COUNT + 1,
                durationSeconds = 30.0,
            )
        val err = assertFailsWith<AgentServiceError.InvalidInput> { preflight.validate() }
        assertEquals("Voice clips must be smaller than 10 MB.", err.message)
    }

    @Test
    fun rejectsClipLongerThan150Seconds() {
        val preflight =
            CodexVoiceTranscriptionPreflight(
                byteCount = 2048,
                durationSeconds = 150.5,
            )
        val err = assertFailsWith<AgentServiceError.InvalidInput> { preflight.validate() }
        assertEquals("Voice clips must be 150 seconds or less.", err.message)
    }

    @Test
    fun acceptsBoundaryDurationAndSize() {
        val p =
            CodexVoiceTranscriptionPreflight(
                byteCount = CodexVoiceTranscriptionPreflight.MAX_BYTE_COUNT,
                durationSeconds = CodexVoiceTranscriptionPreflight.MAX_DURATION_SECONDS,
            )
        assertNull(p.failureMessage)
        p.validate()
    }
}
