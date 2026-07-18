// FILE: CodexService+SecureTransport.swift
// Purpose: Performs the iPhone-side E2EE handshake, wire control routing, and encrypted envelope handling.
// Layer: Service
// Exports: CodexService secure transport helpers
// Depends on: CryptoKit, Foundation, Security, Network

import CryptoKit
import Foundation
import Security

extension CodexService {
    // Completes the secure handshake before any JSON-RPC traffic is sent over the relay.
    func performSecureHandshake() async throws {
        guard let sessionId = normalizedRelaySessionId,
              let macDeviceId = normalizedRelayMacDeviceId else {
            throw CodexSecureTransportError.invalidHandshake(
                "The saved relay pairing is incomplete. Scan a fresh QR code to reconnect."
            )
        }

        let trustedMac = trustedMacRegistry.records[macDeviceId]
        // Fresh QR scans must go through bootstrap once so we verify the scanned session,
        // instead of silently reusing an older trusted-reconnect path.
        let handshakeMode: CodexSecureHandshakeMode = (!shouldForceQRBootstrapOnNextHandshake && trustedMac != nil)
            ? .trustedReconnect
            : .qrBootstrap
        let expectedMacIdentityPublicKey: String
        switch handshakeMode {
        case .trustedReconnect:
            expectedMacIdentityPublicKey = trustedMac?.macIdentityPublicKey ?? ""
            secureConnectionState = .reconnecting
        case .qrBootstrap:
            guard let pairingPublicKey = normalizedRelayMacIdentityPublicKey else {
                throw CodexSecureTransportError.invalidHandshake(
                    "The initial pairing metadata is missing the Mac identity key. Scan a new QR code to reconnect."
                )
            }
            expectedMacIdentityPublicKey = pairingPublicKey
            secureConnectionState = .handshaking
        }

        let phoneEphemeralPrivateKey = Curve25519.KeyAgreement.PrivateKey()
        let clientNonce = randomSecureNonce()
        let clientHello = SecureClientHello(
            protocolVersion: relayProtocolVersion,
            sessionId: sessionId,
            handshakeMode: handshakeMode,
            phoneDeviceId: phoneIdentityState.phoneDeviceId,
            phoneIdentityPublicKey: phoneIdentityState.phoneIdentityPublicKey,
            phoneEphemeralPublicKey: phoneEphemeralPrivateKey.publicKey.rawRepresentation.base64EncodedString(),
            clientNonce: clientNonce.base64EncodedString()
        )
        pendingHandshake = CodexPendingHandshake(
            mode: handshakeMode,
            transcriptBytes: Data(),
            phoneEphemeralPrivateKey: phoneEphemeralPrivateKey,
            phoneDeviceId: phoneIdentityState.phoneDeviceId
        )
        try await sendWireControlMessage(clientHello)

        let serverHello = try await waitForMatchingServerHello(
            expectedSessionId: sessionId,
            expectedMacDeviceId: macDeviceId,
            expectedMacIdentityPublicKey: expectedMacIdentityPublicKey,
            expectedClientNonce: clientHello.clientNonce,
            clientNonce: clientNonce,
            phoneDeviceId: phoneIdentityState.phoneDeviceId,
            phoneIdentityPublicKey: phoneIdentityState.phoneIdentityPublicKey,
            phoneEphemeralPublicKey: clientHello.phoneEphemeralPublicKey
        )
        guard serverHello.protocolVersion == codexSecureProtocolVersion else {
            presentBridgeUpdatePrompt(
                message: "This bridge is using a different secure transport version. Update the agnt package on your computer and try again."
            )
            throw CodexSecureTransportError.incompatibleVersion(
                "This bridge is using a different secure transport version. Update agnt on the iPhone or Mac and try again."
            )
        }
        guard serverHello.sessionId == sessionId else {
            throw CodexSecureTransportError.invalidHandshake("The secure bridge session ID did not match the saved pairing.")
        }
        guard serverHello.macDeviceId == macDeviceId else {
            throw CodexSecureTransportError.invalidHandshake("The bridge reported a different Mac identity for this relay session.")
        }
        guard serverHello.macIdentityPublicKey == expectedMacIdentityPublicKey else {
            throw CodexSecureTransportError.invalidHandshake("The secure Mac identity key did not match the paired device.")
        }

        let serverNonce = Data(base64EncodedOrEmpty: serverHello.serverNonce)
        let transcriptBytes = codexSecureTranscriptBytes(
            sessionId: sessionId,
            protocolVersion: serverHello.protocolVersion,
            handshakeMode: serverHello.handshakeMode,
            keyEpoch: serverHello.keyEpoch,
            macDeviceId: serverHello.macDeviceId,
            phoneDeviceId: phoneIdentityState.phoneDeviceId,
            macIdentityPublicKey: serverHello.macIdentityPublicKey,
            phoneIdentityPublicKey: phoneIdentityState.phoneIdentityPublicKey,
            macEphemeralPublicKey: serverHello.macEphemeralPublicKey,
            phoneEphemeralPublicKey: clientHello.phoneEphemeralPublicKey,
            clientNonce: clientNonce,
            serverNonce: serverNonce,
            expiresAtForTranscript: serverHello.expiresAtForTranscript
        )
        debugSecureLog(
            "verify mode=\(serverHello.handshakeMode.rawValue) session=\(shortSecureId(sessionId)) "
            + "keyEpoch=\(serverHello.keyEpoch) mac=\(shortSecureId(serverHello.macDeviceId)) "
            + "phone=\(shortSecureId(phoneIdentityState.phoneDeviceId)) "
            + "expectedMacKey=\(shortSecureFingerprint(expectedMacIdentityPublicKey)) "
            + "actualMacKey=\(shortSecureFingerprint(serverHello.macIdentityPublicKey)) "
            + "phoneKey=\(shortSecureFingerprint(phoneIdentityState.phoneIdentityPublicKey)) "
            + "transcript=\(shortTranscriptDigest(transcriptBytes))"
        )
        let macPublicKey = try Curve25519.Signing.PublicKey(
            rawRepresentation: Data(base64EncodedOrEmpty: serverHello.macIdentityPublicKey)
        )
        let macSignature = Data(base64EncodedOrEmpty: serverHello.macSignature)
        let isSignatureValid = macPublicKey.isValidSignature(macSignature, for: transcriptBytes)
        debugSecureLog(
            "verify-result mode=\(serverHello.handshakeMode.rawValue) valid=\(isSignatureValid) "
            + "signature=\(shortTranscriptDigest(macSignature))"
        )
        guard isSignatureValid else {
            throw CodexSecureTransportError.invalidHandshake("The secure Mac signature could not be verified.")
        }

        let serverReplayEpoch = serverHello.bridgeReplayEpoch?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let serverReplayEpoch, !serverReplayEpoch.isEmpty,
           serverReplayEpoch != lastAppliedBridgeReplayEpoch {
            let hadPriorReplayState = lastAppliedBridgeReplayEpoch != nil
                || lastAppliedBridgeOutboundSeq > 0
            setBridgeOutboundReplayCursor(to: 0)
            setBridgeReplayEpoch(to: serverReplayEpoch)
            if hadPriorReplayState {
                markReplayDiscontinuityForCanonicalRefresh()
            }
        }

        pendingHandshake = CodexPendingHandshake(
            mode: handshakeMode,
            transcriptBytes: transcriptBytes,
            phoneEphemeralPrivateKey: phoneEphemeralPrivateKey,
            phoneDeviceId: phoneIdentityState.phoneDeviceId
        )

        let phonePrivateKey = try Curve25519.Signing.PrivateKey(
            rawRepresentation: Data(base64EncodedOrEmpty: phoneIdentityState.phoneIdentityPrivateKey)
        )
        let phoneSignatureData = try phonePrivateKey.signature(for: codexClientAuthTranscript(from: transcriptBytes))
        let clientAuth = SecureClientAuth(
            sessionId: sessionId,
            phoneDeviceId: phoneIdentityState.phoneDeviceId,
            keyEpoch: serverHello.keyEpoch,
            phoneSignature: phoneSignatureData.base64EncodedString()
        )
        try await sendWireControlMessage(clientAuth)

        _ = try await waitForMatchingSecureReady(
            expectedSessionId: sessionId,
            expectedKeyEpoch: serverHello.keyEpoch,
            expectedMacDeviceId: macDeviceId
        )

        let macEphemeralPublicKey = try Curve25519.KeyAgreement.PublicKey(
            rawRepresentation: Data(base64EncodedOrEmpty: serverHello.macEphemeralPublicKey)
        )
        let sharedSecret = try phoneEphemeralPrivateKey.sharedSecretFromKeyAgreement(with: macEphemeralPublicKey)
        let salt = SHA256.hash(data: transcriptBytes)
        let infoPrefix = "\(codexSecureHandshakeTag)|\(sessionId)|\(macDeviceId)|\(phoneIdentityState.phoneDeviceId)|\(serverHello.keyEpoch)"
        let phoneToMacKey = sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data(salt),
            sharedInfo: Data("\(infoPrefix)|phoneToMac".utf8),
            outputByteCount: 32
        )
        let macToPhoneKey = sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data(salt),
            sharedInfo: Data("\(infoPrefix)|macToPhone".utf8),
            outputByteCount: 32
        )

        secureSession = CodexSecureSession(
            sessionId: sessionId,
            keyEpoch: serverHello.keyEpoch,
            macDeviceId: macDeviceId,
            macIdentityPublicKey: serverHello.macIdentityPublicKey,
            phoneToMacKey: phoneToMacKey,
            macToPhoneKey: macToPhoneKey,
            lastInboundBridgeOutboundSeq: lastAppliedBridgeOutboundSeq,
            lastInboundCounter: -1,
            nextOutboundCounter: 0
        )
        pendingHandshake = nil
        shouldForceQRBootstrapOnNextHandshake = false
        secureConnectionState = .encrypted
        secureMacFingerprint = codexSecureFingerprint(for: serverHello.macIdentityPublicKey)
        bridgeUpdatePrompt = nil

        if handshakeMode == .qrBootstrap {
            trustMac(
                deviceId: macDeviceId,
                publicKey: serverHello.macIdentityPublicKey,
                relayURL: normalizedRelayURL,
                displayName: trustedMac?.displayName
            )
        }

        try await sendWireControlMessage(
            SecureResumeState(
                sessionId: sessionId,
                keyEpoch: serverHello.keyEpoch,
                lastAppliedBridgeOutboundSeq: lastAppliedBridgeOutboundSeq,
                bridgeReplayEpoch: lastAppliedBridgeReplayEpoch
            )
        )
    }

    // Handles raw relay JSON before any JSON-RPC decoding so secure controls stay separate.
    func processIncomingWireText(_ text: String) {
        if let kind = wireMessageKind(from: text) {
            switch kind {
            case "serverHello", "secureReady", "secureError":
                bufferSecureControlMessage(kind: kind, rawText: text)
                return
            case "encryptedEnvelope":
                handleEncryptedEnvelopeText(text)
                return
            default:
                break
            }
        }

        processIncomingText(text)
    }

    // Encrypts JSON-RPC requests/responses before they leave the iPhone.
    func secureWireText(for plaintext: String) throws -> String {
        guard var secureSession else {
            throw CodexSecureTransportError.invalidHandshake(
                "The secure agnt session is not ready yet. Try reconnecting."
            )
        }

        let payload = SecureApplicationPayload(
            bridgeOutboundSeq: nil,
            payloadText: plaintext
        )
        let payloadData = try JSONEncoder().encode(payload)
        let nonceData = codexSecureNonce(sender: "iphone", counter: secureSession.nextOutboundCounter)
        let nonce = try AES.GCM.Nonce(data: nonceData)
        let sealedBox = try AES.GCM.seal(payloadData, using: secureSession.phoneToMacKey, nonce: nonce)
        let envelope = SecureEnvelope(
            kind: "encryptedEnvelope",
            v: codexSecureProtocolVersion,
            sessionId: secureSession.sessionId,
            keyEpoch: secureSession.keyEpoch,
            sender: "iphone",
            counter: secureSession.nextOutboundCounter,
            ciphertext: sealedBox.ciphertext.base64EncodedString(),
            tag: sealedBox.tag.base64EncodedString()
        )
        secureSession.nextOutboundCounter += 1
        self.secureSession = secureSession
        let data = try JSONEncoder().encode(envelope)
        guard let text = String(data: data, encoding: .utf8) else {
            throw CodexSecureTransportError.invalidHandshake("Unable to encode the secure agnt envelope.")
        }
        return text
    }

    // Saves the QR-derived bridge metadata used for secure reconnects.
    func rememberRelayPairing(_ payload: CodexPairingQRPayload) {
        SecureStore.writeString(payload.sessionId, for: CodexSecureKeys.relaySessionId)
        SecureStore.writeString(payload.relay, for: CodexSecureKeys.relayUrl)
        SecureStore.writeString(payload.macDeviceId, for: CodexSecureKeys.relayMacDeviceId)
        SecureStore.writeString(payload.macIdentityPublicKey, for: CodexSecureKeys.relayMacIdentityPublicKey)
        SecureStore.writeString(String(codexSecureProtocolVersion), for: CodexSecureKeys.relayProtocolVersion)
        SecureStore.writeString("0", for: CodexSecureKeys.relayLastAppliedBridgeOutboundSeq)
        SecureStore.deleteValue(for: CodexSecureKeys.relayBridgeReplayEpoch)
        relaySessionId = payload.sessionId
        relayUrl = payload.relay
        relayMacDeviceId = payload.macDeviceId
        relayMacIdentityPublicKey = payload.macIdentityPublicKey
        relayProtocolVersion = codexSecureProtocolVersion
        lastAppliedBridgeOutboundSeq = 0
        lastAppliedBridgeReplayEpoch = nil
        shouldForceQRBootstrapOnNextHandshake = true
        trustedReconnectFailureCount = 0
        secureConnectionState = trustedMacRegistry.records[payload.macDeviceId] == nil ? .handshaking : .trustedMac
        secureMacFingerprint = codexSecureFingerprint(for: payload.macIdentityPublicKey)
    }

    // Resets volatile secure state while preserving the trusted-device registry.
    func resetSecureTransportState(preservePendingQRBootstrapState: Bool = false) {
        secureSession = nil
        pendingHandshake = nil
        let continuations = pendingSecureControlContinuations
        pendingSecureControlContinuations.removeAll()
        bufferedSecureControlMessages.removeAll()

        for waiters in continuations.values {
            for waiter in waiters {
                waiter.continuation.resume(throwing: CodexServiceError.disconnected)
            }
        }

        if secureConnectionState == .rePairRequired || secureConnectionState == .updateRequired {
            return
        }

        if shouldForceQRBootstrapOnNextHandshake, normalizedRelaySessionId != nil {
            // Fresh scans should stay visually "in progress" while the connect path is spinning up,
            // but real disconnects still fall back to a stable saved-pair/not-paired presentation.
            if preservePendingQRBootstrapState {
                secureConnectionState = trustedMacRegistry.records[relayMacDeviceId ?? ""] == nil ? .handshaking : .trustedMac
            } else {
                secureConnectionState = trustedMacRegistry.records[relayMacDeviceId ?? ""] == nil ? .notPaired : .trustedMac
            }
            secureMacFingerprint = normalizedRelayMacIdentityPublicKey.map { codexSecureFingerprint(for: $0) }
            return
        }

        if let relayMacDeviceId,
           let trustedMac = trustedMacRegistry.records[relayMacDeviceId] {
            secureConnectionState = .trustedMac
            secureMacFingerprint = codexSecureFingerprint(for: trustedMac.macIdentityPublicKey)
        } else if let trustedMac = currentTrustedMacRecord {
            secureConnectionState = .liveSessionUnresolved
            secureMacFingerprint = codexSecureFingerprint(for: trustedMac.macIdentityPublicKey)
        } else if normalizedRelaySessionId != nil {
            secureConnectionState = .notPaired
            secureMacFingerprint = nil
        } else {
            secureConnectionState = .notPaired
            secureMacFingerprint = nil
        }
    }

    // Used by: ContentViewModel trusted reconnect path.
    func resolveTrustedMacSession(deviceId: String? = nil) async throws -> CodexTrustedSessionResolveResponse {
        let resolver = trustedSessionResolverOverride ?? { [weak self] in
            guard let self else {
                throw CancellationError()
            }
            return try await self.resolveTrustedMacSessionImpl(deviceId: deviceId)
        }
        let resolveTaskID = UUID()
        let task = Task {
            try await resolver()
        }

        trustedSessionResolveTask = task
        trustedSessionResolveTaskID = resolveTaskID
        defer {
            if trustedSessionResolveTaskID == resolveTaskID {
                trustedSessionResolveTask = nil
                trustedSessionResolveTaskID = nil
            }
        }

        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    // Lets manual reconnect / fresh QR pairing preempt a stuck trusted-session HTTP lookup.
    func cancelTrustedSessionResolve() {
        trustedSessionResolveTask?.cancel()
        trustedSessionResolveTask = nil
        trustedSessionResolveTaskID = nil
    }

    // Persists the resolved live relay session and resets replay cursors when the live session changed.
    func applyResolvedTrustedSession(_ resolved: CodexTrustedSessionResolveResponse, relayURL: String) {
        let previousSessionId = normalizedRelaySessionId
        let shouldResetReplayCursor = previousSessionId == nil || previousSessionId != resolved.sessionId
        if shouldResetReplayCursor {
            setBridgeOutboundReplayCursor(to: 0)
            setBridgeReplayEpoch(to: nil)
        }
        rememberResolvedTrustedSession(resolved, relayURL: relayURL)
    }

    // Resolves a short manual pairing code through the best-known relay for this app instance.
    func resolvePairingCode(_ code: String) async throws -> CodexPairingQRPayload {
        let normalizedCode = code
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: " ", with: "")
        guard !normalizedCode.isEmpty else {
            throw CodexSecureTransportError.invalidQR("Enter a valid pairing code.")
        }

        guard let relayURL = preferredPairingCodeRelayURL else {
            throw CodexSecureTransportError.invalidQR(
                "This iPhone does not know which relay to ask for that pairing code yet. Scan the QR code instead."
            )
        }

        let resolveURLs = CodexPairingCodeResolveURLBuilder.candidates(from: relayURL)
        guard !resolveURLs.isEmpty else {
            throw CodexSecureTransportError.invalidQR("The relay URL for pairing codes is invalid.")
        }

        var lastRetriableError: CodexSecureTransportError?
        for (index, resolveURL) in resolveURLs.enumerated() {
            do {
                return try await sendPairingCodeResolveRequest(
                    code: normalizedCode,
                    relayURL: relayURL,
                    resolveURL: resolveURL
                )
            } catch let error as CodexSecureTransportError {
                guard shouldTryNextPairingCodeResolveCandidate(after: error),
                      index < resolveURLs.count - 1 else {
                    throw error
                }
                lastRetriableError = error
                continue
            }
        }

        throw lastRetriableError ?? CodexSecureTransportError.invalidQR("The relay could not resolve that pairing code.")
    }
}
