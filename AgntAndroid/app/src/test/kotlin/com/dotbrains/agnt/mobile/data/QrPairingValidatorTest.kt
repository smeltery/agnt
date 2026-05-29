package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.AGNT_PAIRING_QR_VERSION
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.test.fail

class QrPairingValidatorTest {
    private val validMacIdentityPublicKey = Base64.getEncoder().encodeToString(ByteArray(32) { it.toByte() })

    @Test
    fun wrongVersion_requestsBridgeUpdate() {
        val json =
            """
			{"v":${AGNT_PAIRING_QR_VERSION + 1},"relay":"ws://127.0.0.1:9000","sessionId":"s",
			"macDeviceId":"m","macIdentityPublicKey":"$validMacIdentityPublicKey","expiresAt":9999999999999}
            """.trimIndent()
        val r = validatePairingQrCode(json)
        assertIs<QrPairingValidationResult.BridgeUpdateRequired>(r)
    }

    @Test
    fun validPayload_succeeds() {
        val now = 1_700_000_000_000L
        val expires = now + 3600_000L
        val json =
            """
			{"v":$AGNT_PAIRING_QR_VERSION,"relay":"ws://192.168.1.5:9000","sessionId":"sess",
			"macDeviceId":"mac","macIdentityPublicKey":"$validMacIdentityPublicKey","expiresAt":$expires}
            """.trimIndent()
        val r = validatePairingQrCode(json, nowEpochMillis = now)
        assertIs<QrPairingValidationResult.Success>(r)
        assertTrue(r.payload.sessionId == "sess")
    }

    @Test
    fun shortPairingCode_returnsLookupRequest() {
        val r = validatePairingQrCode("ab23-cd34ef")
        val shortCode = assertIs<QrPairingValidationResult.ShortCode>(r)
        assertEquals("AB23CD34EF", shortCode.code)
    }

    @Test
    fun pasteablePairingCode_decodesPayload() {
        val now = 1_700_000_000_000L
        val expires = now + 3600_000L
        val json =
            """
            {"v":$AGNT_PAIRING_QR_VERSION,"relay":"ws://192.168.1.5:9000","sessionId":"sess",
            "macDeviceId":"mac","macIdentityPublicKey":"$validMacIdentityPublicKey","expiresAt":$expires}
            """.trimIndent()
        val encoded =
            Base64
                .getEncoder()
                .encodeToString(json.toByteArray())
                .replace("+", "-")
                .replace("/", "_")
                .replace("=", "")

        val r = validatePairingQrCode("RMX1:$encoded", nowEpochMillis = now)

        val success = assertIs<QrPairingValidationResult.Success>(r)
        assertEquals("mac", success.payload.macDeviceId)
    }

    @Test
    fun publicCleartextRelay_isRejected() {
        val now = 1_700_000_000_000L
        val expires = now + 3600_000L
        val json =
            """
			{"v":$AGNT_PAIRING_QR_VERSION,"relay":"ws://relay.example.com:9000","sessionId":"sess",
			"macDeviceId":"mac","macIdentityPublicKey":"$validMacIdentityPublicKey","expiresAt":$expires}
            """.trimIndent()
        val r = validatePairingQrCode(json, nowEpochMillis = now)
        assertIs<QrPairingValidationResult.ScanError>(r)
    }

    @Test
    fun malformedMacIdentityKey_isRejected() {
        val now = 1_700_000_000_000L
        val expires = now + 3600_000L
        val json =
            """
			{"v":$AGNT_PAIRING_QR_VERSION,"relay":"ws://192.168.1.5:9000","sessionId":"sess",
			"macDeviceId":"mac","macIdentityPublicKey":"not-a-key","expiresAt":$expires}
            """.trimIndent()
        val r = validatePairingQrCode(json, nowEpochMillis = now)
        assertIs<QrPairingValidationResult.ScanError>(r)
    }

    @Test
    fun unsafeIdentifierChars_areRejected() {
        val now = 1_700_000_000_000L
        val expires = now + 3600_000L
        val json =
            """
			{"v":$AGNT_PAIRING_QR_VERSION,"relay":"ws://192.168.1.5:9000","sessionId":"sess token",
			"macDeviceId":"mac","macIdentityPublicKey":"$validMacIdentityPublicKey","expiresAt":$expires}
            """.trimIndent()
        val r = validatePairingQrCode(json, nowEpochMillis = now)
        assertIs<QrPairingValidationResult.ScanError>(r)
    }

    @Test
    fun resolvePairingCode_buildsPayloadFromRelayResponse() =
        runTest {
            val now = 1_700_000_000_000L
            val expires = now + 3600_000L
            MockWebServer().use { server ->
                server.enqueue(
                    MockResponse()
                        .setResponseCode(200)
                        .setHeader("content-type", "application/json")
                        .setBody(
                            """
							{"ok":true,"v":$AGNT_PAIRING_QR_VERSION,"sessionId":"sess",
							"macDeviceId":"mac","macIdentityPublicKey":"$validMacIdentityPublicKey","expiresAt":$expires}
                            """.trimIndent(),
                        ),
                )

                server.start()
                val relayUrl = "ws://127.0.0.1:${server.port}/relay"
                val result =
                    resolvePairingCode(
                        httpClient = OkHttpClient(),
                        relayUrl = relayUrl,
                        code = "AB23-CD34EF",
                        nowEpochMillis = now,
                    )

                if (result is QrPairingValidationResult.ScanError) fail(result.message)
                val success = assertIs<QrPairingValidationResult.Success>(result)
                assertEquals("sess", success.payload.sessionId)
                assertEquals(relayUrl, success.payload.relay)
                val request = server.takeRequest()
                assertEquals("/v1/pairing/code/resolve", request.path)
            }
        }

    @Test
    fun resolvePairingCode_routesAroundExistingRelayPathSuffix() =
        runTest {
            // The validator should strip a trailing /relay segment before
            // appending /v1/pairing/code/resolve, otherwise a relay URL
            // like ws://host/relay would POST to /relay/v1/pairing/code/resolve
            // and 404.
            val now = 1_700_000_000_000L
            val expires = now + 3600_000L
            MockWebServer().use { server ->
                server.enqueue(
                    MockResponse()
                        .setResponseCode(200)
                        .setHeader("content-type", "application/json")
                        .setBody(
                            """
							{"ok":true,"v":$AGNT_PAIRING_QR_VERSION,"sessionId":"sess",
							"macDeviceId":"mac","macIdentityPublicKey":"$validMacIdentityPublicKey","expiresAt":$expires}
                            """.trimIndent(),
                        ),
                )

                server.start()
                val relayUrl = "ws://127.0.0.1:${server.port}/relay"
                val result =
                    resolvePairingCode(
                        httpClient = OkHttpClient(),
                        relayUrl = relayUrl,
                        code = "AB23CD34EF",
                        nowEpochMillis = now,
                    )

                if (result is QrPairingValidationResult.ScanError) fail(result.message)
                assertIs<QrPairingValidationResult.Success>(result)
                val request = server.takeRequest()
                assertEquals("/v1/pairing/code/resolve", request.path)
            }
        }

    @Test
    fun resolvePairingCode_surfacesExpiredCodeFromRelay() =
        runTest {
            MockWebServer().use { server ->
                server.enqueue(
                    MockResponse()
                        .setResponseCode(410)
                        .setHeader("content-type", "application/json")
                        .setBody("""{"ok":false,"code":"pairing_code_expired","error":"expired"}"""),
                )

                server.start()
                val result =
                    resolvePairingCode(
                        httpClient = OkHttpClient(),
                        relayUrl = "ws://127.0.0.1:${server.port}/relay",
                        code = "AB23CD34EF",
                    )

                val err = assertIs<QrPairingValidationResult.ScanError>(result)
                assertTrue(err.message.contains("expired"))
            }
        }

    @Test
    fun resolvePairingCode_surfacesUnavailableCodeFromRelay() =
        runTest {
            MockWebServer().use { server ->
                server.enqueue(
                    MockResponse()
                        .setResponseCode(404)
                        .setHeader("content-type", "application/json")
                        .setBody("""{"ok":false,"code":"pairing_code_unavailable","error":"unavailable"}"""),
                )

                server.start()
                val result =
                    resolvePairingCode(
                        httpClient = OkHttpClient(),
                        relayUrl = "ws://127.0.0.1:${server.port}/relay",
                        code = "AB23CD34EF",
                    )

                val err = assertIs<QrPairingValidationResult.ScanError>(result)
                assertTrue(err.message.contains("not available"))
            }
        }

    @Test
    fun resolvePairingCode_surfaces404WithoutErrorCodeAsRelayMissing() =
        runTest {
            MockWebServer().use { server ->
                server.enqueue(MockResponse().setResponseCode(404))

                server.start()
                val result =
                    resolvePairingCode(
                        httpClient = OkHttpClient(),
                        relayUrl = "ws://127.0.0.1:${server.port}/relay",
                        code = "AB23CD34EF",
                    )

                val err = assertIs<QrPairingValidationResult.ScanError>(result)
                assertTrue(err.message.contains("does not support pairing codes"))
            }
        }

    @Test
    fun resolvePairingCode_preservesRelayPathPrefix() =
        runTest {
            val now = 1_700_000_000_000L
            val expires = now + 3600_000L
            MockWebServer().use { server ->
                server.enqueue(
                    MockResponse()
                        .setResponseCode(200)
                        .setHeader("content-type", "application/json")
                        .setBody(
                            """
                            {"ok":true,"v":$AGNT_PAIRING_QR_VERSION,"sessionId":"sess",
                            "macDeviceId":"mac","macIdentityPublicKey":"$validMacIdentityPublicKey","expiresAt":$expires}
                            """.trimIndent(),
                        ),
                )

                server.start()
                val relayUrl = "ws://127.0.0.1:${server.port}/agnt/relay"
                val result =
                    resolvePairingCode(
                        httpClient = OkHttpClient(),
                        relayUrl = relayUrl,
                        code = "ab23-cd34ef",
                        nowEpochMillis = now,
                    )

                if (result is QrPairingValidationResult.ScanError) fail(result.message)
                val success = assertIs<QrPairingValidationResult.Success>(result)
                assertEquals(relayUrl, success.payload.relay)
                val request = server.takeRequest()
                assertEquals("/agnt/v1/pairing/code/resolve", request.path)
            }
        }

    @Test
    fun resolvePairingCode_rejectsMalformedRelayResponseFields() =
        runTest {
            val now = 1_700_000_000_000L
            val expires = now + 3600_000L
            MockWebServer().use { server ->
                server.enqueue(
                    MockResponse()
                        .setResponseCode(200)
                        .setHeader("content-type", "application/json")
                        .setBody(
                            """
							{"ok":true,"v":$AGNT_PAIRING_QR_VERSION,"sessionId":"sess with spaces",
							"macDeviceId":"mac","macIdentityPublicKey":"$validMacIdentityPublicKey","expiresAt":$expires}
                            """.trimIndent(),
                        ),
                )

                server.start()
                val relayUrl = "ws://127.0.0.1:${server.port}/relay"
                val result =
                    resolvePairingCode(
                        httpClient = OkHttpClient(),
                        relayUrl = relayUrl,
                        code = "AB23-CD34EF",
                        nowEpochMillis = now,
                    )

                assertIs<QrPairingValidationResult.ScanError>(result)
            }
        }
}
