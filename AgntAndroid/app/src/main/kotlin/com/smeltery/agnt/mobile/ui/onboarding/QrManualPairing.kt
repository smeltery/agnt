package com.smeltery.agnt.mobile.ui.onboarding

import android.content.Context
import com.smeltery.agnt.mobile.AppContainer
import com.smeltery.agnt.mobile.core.config.AppEnvironment
import com.smeltery.agnt.mobile.core.model.CodexTrustedMacRegistry
import com.smeltery.agnt.mobile.core.security.CodexSecureKeys
import com.smeltery.agnt.mobile.core.transport.validateRelayUrl
import com.smeltery.agnt.mobile.data.QrPairingValidationResult
import com.smeltery.agnt.mobile.data.resolvePairingCode

internal data class ManualPairingInput(
    val codeOrPayload: String,
    val relayUrl: String?,
)

private val manualPairingRelayUrlRegex = Regex("""(?i)\b(?:wss?|https?)://[^\s,;)"']+""")
private val manualPairingCodeLabelRegex =
    Regex("""(?im)^\s*(?:pairing\s+)?code\s*[:=]\s*([A-Za-z0-9._:-]+)\s*$""")
private val manualPairingShortCodeRegex = Regex("""\b[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8,12}\b""")
private val manualPairingTokenRegex = Regex("""[A-Za-z0-9._:-]{4,256}""")

internal fun parseManualPairingInput(rawText: String): ManualPairingInput {
    val trimmed = rawText.trim()
    if (trimmed.isEmpty()) return ManualPairingInput(codeOrPayload = "", relayUrl = null)

    val relayUrl = extractManualRelayUrl(trimmed)
    if (trimmed.startsWith("{")) {
        return ManualPairingInput(codeOrPayload = trimmed, relayUrl = relayUrl)
    }

    val labeledCode =
        manualPairingCodeLabelRegex
            .find(trimmed)
            ?.groups
            ?.get(1)
            ?.value
    if (!labeledCode.isNullOrBlank()) {
        return ManualPairingInput(codeOrPayload = labeledCode.trim(), relayUrl = relayUrl)
    }

    val textWithoutRelay =
        relayUrl?.let { trimmed.replace(it, " ") } ?: trimmed
    val shortCode = manualPairingShortCodeRegex.find(textWithoutRelay.uppercase())?.value
    if (!shortCode.isNullOrBlank()) {
        return ManualPairingInput(codeOrPayload = shortCode, relayUrl = relayUrl)
    }

    val token =
        manualPairingTokenRegex
            .findAll(textWithoutRelay)
            .map { it.value.trim() }
            .firstOrNull { token ->
                !token.equals("code", ignoreCase = true) &&
                    !token.equals("pairing", ignoreCase = true)
            }
    return ManualPairingInput(codeOrPayload = token ?: textWithoutRelay.trim(), relayUrl = relayUrl)
}

private fun extractManualRelayUrl(rawText: String): String? =
    manualPairingRelayUrlRegex
        .find(rawText)
        ?.value
        ?.trim()
        ?.trimEnd('.', ',', ';', ')', ']', '}', '"', '\'')
        ?.takeIf { it.isNotBlank() }

private fun manualRelayCandidates(
    context: Context,
    pastedRelayUrl: String?,
): List<String> {
    val snapshot = AppContainer.sessionPersistence.loadRelaySnapshot()
    val registry =
        AppContainer.secureStore.readCodable<CodexTrustedMacRegistry>(CodexSecureKeys.trustedMacRegistry)
    val preferredTrustedRelay =
        snapshot.lastTrustedMacDeviceId
            ?.let { registry?.records?.get(it) }
            ?.relayURL
            ?: registry
                ?.records
                ?.values
                ?.firstOrNull { !it.relayURL.isNullOrBlank() }
                ?.relayURL

    return listOf(
        pastedRelayUrl,
        snapshot.relayUrl,
        preferredTrustedRelay,
        AppEnvironment.relayBaseURL(context),
    ).mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }
        .filter { validateRelayUrl(it) != null }
        .distinct()
}

internal suspend fun resolveManualPairingCode(
    context: Context,
    code: String,
    pastedRelayUrl: String? = null,
): QrPairingValidationResult {
    val relayCandidates = manualRelayCandidates(context, pastedRelayUrl)
    if (relayCandidates.isEmpty()) {
        return QrPairingValidationResult.ScanError(
            "This device does not know which relay to ask for that pairing code yet. Scan the QR code instead.",
        )
    }
    return resolvePairingCodeWithCandidates(relayCandidates, code)
}

private suspend fun resolvePairingCodeWithCandidates(
    relayCandidates: List<String>,
    code: String,
): QrPairingValidationResult {
    var lastScanError: QrPairingValidationResult.ScanError? = null
    for (relayUrl in relayCandidates) {
        when (
            val result =
                resolvePairingCode(
                    httpClient = AppContainer.httpCallClient,
                    relayUrl = relayUrl,
                    code = code,
                )
        ) {
            is QrPairingValidationResult.Success -> return result
            is QrPairingValidationResult.BridgeUpdateRequired -> return result
            is QrPairingValidationResult.ShortCode ->
                lastScanError =
                    QrPairingValidationResult.ScanError(
                        "The relay returned another short pairing code instead of pairing metadata.",
                    )
            is QrPairingValidationResult.ScanError -> lastScanError = result
        }
    }
    return lastScanError
        ?: QrPairingValidationResult.ScanError(
            "Pairing code could not be resolved. Generate a fresh code from your desktop.",
        )
}
