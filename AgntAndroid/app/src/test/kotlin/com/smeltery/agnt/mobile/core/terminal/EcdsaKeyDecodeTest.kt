package com.smeltery.agnt.mobile.core.terminal

import net.schmizz.sshj.common.KeyType
import net.schmizz.sshj.userauth.keyprovider.PKCS8KeyFile
import java.io.StringReader
import java.security.KeyPairGenerator
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

/**
 * `NativeSshTerminal.open` delegates SSH key parsing to sshj's
 * `client.loadKeys(...)`, which routes to `PKCS8KeyFile` for the
 * `-----BEGIN PRIVATE KEY-----` (PKCS#8) wrapper. The Windows setup guide and
 * the user-facing `TerminalError.UnsupportedPrivateKey` message now mention
 * ECDSA alongside Ed25519/RSA — this test pins that the underlying decoder
 * actually accepts an ECDSA P-256 key so the docs don't drift away from
 * reality. The other supported curves (P-384, P-521) share the same code
 * path; covering one curve is enough to catch a regression in the loader
 * wiring.
 */
class EcdsaKeyDecodeTest {
    @Test
    fun pkcs8EcdsaP256KeyRoundTripsThroughSshj() {
        val keyPair =
            KeyPairGenerator
                .getInstance("EC")
                .apply {
                    initialize(ECGenParameterSpec("secp256r1"))
                }.generateKeyPair()
        val privateKey = keyPair.private as ECPrivateKey

        val pem =
            buildString {
                append("-----BEGIN PRIVATE KEY-----\n")
                // PKCS#8 DER body, base64'd in 64-char lines (the OpenSSH /
                // OpenSSL classic encoding sshj's PKCS8KeyFile accepts).
                val encoded = Base64.getEncoder().encodeToString(privateKey.encoded)
                encoded.chunked(64).forEach { line ->
                    append(line)
                    append('\n')
                }
                append("-----END PRIVATE KEY-----\n")
            }

        val keyFile = PKCS8KeyFile()
        keyFile.init(StringReader(pem))

        val loadedPrivate = keyFile.private
        val loadedPublic = keyFile.public
        assertNotNull(loadedPrivate, "PKCS8KeyFile failed to load an ECDSA P-256 key")
        assertNotNull(loadedPublic, "PKCS8KeyFile loaded private but no public counterpart")

        // sshj uses the curve-name in the OpenSSH wire-format type tag —
        // verifying the type maps to ECDSA256 catches the case where the
        // loader picks up the bytes but mislabels them (e.g. as RSA).
        assertEquals(KeyType.ECDSA256, KeyType.fromKey(loadedPublic as ECPublicKey))
    }
}
