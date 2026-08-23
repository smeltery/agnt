package com.smeltery.agnt.mobile.services

import com.smeltery.agnt.mobile.core.error.AgentServiceError
import com.smeltery.agnt.mobile.core.model.JSONValue
import com.smeltery.agnt.mobile.core.model.RPCError
import com.smeltery.agnt.mobile.core.voice.GptVoiceTranscriptionError
import com.smeltery.agnt.mobile.services.agent.voice.parseVoiceAuthTokenFromResult
import com.smeltery.agnt.mobile.services.agent.voice.rpcIndicatesUnsupportedVoiceBridgeAuth
import com.smeltery.agnt.mobile.services.agent.voice.transcribeWavWithSingleAuthRetry
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class VoiceTranscriptionAuthTest {
    @Test
    fun parseTokenFromTopLevelObject() {
        val token =
            parseVoiceAuthTokenFromResult(
                JSONValue.Obj(mapOf("token" to JSONValue.Str("  abc  "))),
            )
        assertEquals("abc", token)
    }

    @Test
    fun parseTokenFromNestedData() {
        val token =
            parseVoiceAuthTokenFromResult(
                JSONValue.Obj(
                    mapOf(
                        "data" to
                            JSONValue.Obj(
                                mapOf("token" to JSONValue.Str("nested")),
                            ),
                    ),
                ),
            )
        assertEquals("nested", token)
    }

    @Test
    fun parseTokenInvalidThrows() {
        assertFailsWith<AgentServiceError.InvalidResponse> {
            parseVoiceAuthTokenFromResult(JSONValue.Obj(mapOf("token" to JSONValue.Str("   "))))
        }
    }

    @Test
    fun rpcClassificationMatchesIosFixture() {
        val rpc =
            RPCError(
                code = -32600,
                message =
                    "Invalid request: unknown variant `voice/resolveAuth`, expected one of `initialize`, `thread/start`",
                data = null,
            )
        assertTrue(rpcIndicatesUnsupportedVoiceBridgeAuth(rpc))
    }

    @Test
    fun transcribeRetriesOnceAfterAuthExpired() =
        runTest {
            var resolveCount = 0
            val resolveToken: suspend () -> String = {
                resolveCount++
                if (resolveCount == 1) "first" else "second"
            }
            var transcribeCount = 0
            val transcribe: suspend (ByteArray, String) -> String = { _, token ->
                transcribeCount++
                when (token) {
                    "first" -> throw GptVoiceTranscriptionError.AuthExpired
                    else -> "done"
                }
            }
            val out =
                transcribeWavWithSingleAuthRetry(
                    wavBytes = byteArrayOf(1),
                    resolveToken = resolveToken,
                    transcribe = transcribe,
                )
            assertEquals("done", out)
            assertEquals(2, resolveCount)
            assertEquals(2, transcribeCount)
        }

    @Test
    fun transcribeSingleRoundWhenSuccessful() =
        runTest {
            var resolveCount = 0
            val resolveToken: suspend () -> String = {
                resolveCount++
                "only"
            }
            var transcribeCount = 0
            val transcribe: suspend (ByteArray, String) -> String = { _, _ ->
                transcribeCount++
                "ok"
            }
            val out =
                transcribeWavWithSingleAuthRetry(
                    wavBytes = byteArrayOf(),
                    resolveToken = resolveToken,
                    transcribe = transcribe,
                )
            assertEquals("ok", out)
            assertEquals(1, resolveCount)
            assertEquals(1, transcribeCount)
        }
}
