// FILE: CodexService+SecureControlMessages.swift
// Purpose: Routes secure control frames and encrypted envelopes during the relay session.
// Layer: Service
// Exports: CodexService secure control helpers
// Depends on: CryptoKit, Foundation

import CryptoKit
import Foundation

extension CodexService {
    // Centralizes the bridge-update guidance so every mismatch shows the same Mac command.
    func presentBridgeUpdatePrompt(message: String) {
        bridgeUpdatePrompt = CodexBridgeUpdatePrompt(
            title: "Update the agnt package on your computer",
            message: message,
            command: "npm install -g @dotbrains/agnt@latest"
        )
    }

    func sendWireControlMessage<Value: Encodable>(_ value: Value) async throws {
        let data = try JSONEncoder().encode(value)
        guard let text = String(data: data, encoding: .utf8) else {
            throw CodexSecureTransportError.invalidHandshake("Unable to encode the secure agnt control payload.")
        }
        try await sendRawText(text)
    }

    func waitForSecureControlMessage(kind: String, timeoutSeconds: TimeInterval = 12) async throws -> String {
        if let bufferedSecureError = bufferedSecureControlMessages["secureError"]?.first,
           let secureError = try? decodeSecureControl(SecureErrorMessage.self, from: bufferedSecureError) {
            bufferedSecureControlMessages["secureError"] = []
            throw CodexSecureTransportError.secureError(secureError.message)
        }

        if var buffered = bufferedSecureControlMessages[kind], !buffered.isEmpty {
            let first = buffered.removeFirst()
            bufferedSecureControlMessages[kind] = buffered
            return first
        }

        let waiterID = UUID()
        let timeoutMessage = "Timed out waiting for the secure agnt \(kind) message."

        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            pendingSecureControlContinuations[kind, default: []].append(
                CodexSecureControlWaiter(id: waiterID, continuation: continuation)
            )

            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                guard let self else { return }
                self.resumePendingSecureControlWaiterIfNeeded(
                    kind: kind,
                    waiterID: waiterID,
                    result: .failure(CodexSecureTransportError.timedOut(timeoutMessage))
                )
            }
        }
    }

    func bufferSecureControlMessage(kind: String, rawText: String) {
        if kind == "secureError",
           let secureError = try? decodeSecureControl(SecureErrorMessage.self, from: rawText) {
            lastErrorMessage = secureError.message
            if secureError.code == "update_required" {
                secureConnectionState = .updateRequired
                presentBridgeUpdatePrompt(message: secureError.message)
            } else if secureError.code == "pairing_expired"
                || secureError.code == "phone_not_trusted"
                || secureError.code == "phone_identity_changed"
                || secureError.code == "phone_replacement_required" {
                secureConnectionState = .rePairRequired
            }

            let continuations = pendingSecureControlContinuations
            pendingSecureControlContinuations.removeAll()
            bufferedSecureControlMessages.removeAll()
            for waiters in continuations.values {
                for waiter in waiters {
                    waiter.continuation.resume(throwing: CodexSecureTransportError.secureError(secureError.message))
                }
            }
            if continuations.isEmpty {
                bufferedSecureControlMessages["secureError"] = [rawText]
            }
            return
        }

        if var waiters = pendingSecureControlContinuations[kind], !waiters.isEmpty {
            let waiter = waiters.removeFirst()
            if waiters.isEmpty {
                pendingSecureControlContinuations.removeValue(forKey: kind)
            } else {
                pendingSecureControlContinuations[kind] = waiters
            }
            waiter.continuation.resume(returning: rawText)
            return
        }

        bufferedSecureControlMessages[kind, default: []].append(rawText)
    }

    // Resumes a specific secure-control waiter once, so timeout tasks cannot double-resume it.
    func resumePendingSecureControlWaiterIfNeeded(
        kind: String,
        waiterID: UUID,
        result: Result<String, Error>
    ) {
        guard var waiters = pendingSecureControlContinuations[kind],
              let waiterIndex = waiters.firstIndex(where: { $0.id == waiterID }) else {
            return
        }

        let waiter = waiters.remove(at: waiterIndex)
        if waiters.isEmpty {
            pendingSecureControlContinuations.removeValue(forKey: kind)
        } else {
            pendingSecureControlContinuations[kind] = waiters
        }
        waiter.continuation.resume(with: result)
    }

    func handleEncryptedEnvelopeText(_ text: String) {
        // No active session yet (handshake in progress) — silently drop stale envelopes.
        guard var secureSession else { return }

        guard let envelope = try? decodeSecureControl(SecureEnvelope.self, from: text),
              envelope.sessionId == secureSession.sessionId,
              envelope.keyEpoch == secureSession.keyEpoch,
              envelope.sender == "mac",
              envelope.counter > secureSession.lastInboundCounter else {
            lastErrorMessage = "The secure agnt payload could not be verified."
            secureConnectionState = .rePairRequired
            return
        }

        do {
            let nonce = try AES.GCM.Nonce(
                data: codexSecureNonce(sender: envelope.sender, counter: envelope.counter)
            )
            let sealedBox = try AES.GCM.SealedBox(
                nonce: nonce,
                ciphertext: Data(base64EncodedOrEmpty: envelope.ciphertext),
                tag: Data(base64EncodedOrEmpty: envelope.tag)
            )
            let plaintext = try AES.GCM.open(sealedBox, using: secureSession.macToPhoneKey)
            let payload = try JSONDecoder().decode(SecureApplicationPayload.self, from: plaintext)
            secureSession.lastInboundCounter = envelope.counter
            self.secureSession = secureSession

            if let bridgeOutboundSeq = payload.bridgeOutboundSeq {
                if bridgeOutboundSeq <= lastAppliedBridgeOutboundSeq {
                    return
                }
                advanceBridgeOutboundReplayCursor(to: bridgeOutboundSeq)
            }

            lastRawMessage = payload.payloadText
            processIncomingText(payload.payloadText)
        } catch {
            lastErrorMessage = CodexSecureTransportError.decryptFailed.localizedDescription
            secureConnectionState = .rePairRequired
        }
    }

}
