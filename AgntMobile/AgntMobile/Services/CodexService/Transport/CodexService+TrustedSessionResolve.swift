// FILE: CodexService+TrustedSessionResolve.swift
// Purpose: Resolves trusted Mac sessions and manual pairing codes through relay HTTP endpoints.
// Layer: Service
// Exports: CodexService trusted session helpers
// Depends on: CryptoKit, Foundation

import CryptoKit
import Foundation

extension CodexService {
    func trustMac(deviceId: String, publicKey: String, relayURL: String?, displayName: String?) {
        let existing = trustedMacRegistry.records[deviceId]
        trustedMacRegistry.records[deviceId] = CodexTrustedMacRecord(
            macDeviceId: deviceId,
            macIdentityPublicKey: publicKey,
            lastPairedAt: Date(),
            relayURL: relayURL ?? existing?.relayURL,
            displayName: displayName ?? existing?.displayName,
            lastResolvedSessionId: existing?.lastResolvedSessionId,
            lastResolvedAt: existing?.lastResolvedAt,
            lastUsedAt: Date()
        )
        SecureStore.writeCodable(trustedMacRegistry, for: CodexSecureKeys.trustedMacRegistry)
        setCurrentTrustedMacDeviceId(deviceId)
        SecureStore.writeString(deviceId, for: CodexSecureKeys.lastTrustedMacDeviceId)
        lastTrustedMacDeviceId = deviceId
        secureMacFingerprint = codexSecureFingerprint(for: publicKey)
    }
}

enum CodexTrustedSessionResolveURLBuilder {
    // Builds both proxy-relative and root HTTP resolve routes from the remembered WebSocket relay URL.
    static func candidates(from relayURL: String) -> [URL] {
        relayResolveCandidates(
            from: relayURL,
            route: ["v1", "trusted", "session", "resolve"],
            includePathPreservingRoute: false
        )
    }
}

enum CodexPairingCodeResolveURLBuilder {
    // Tries path-preserving, proxy-stripped, and root resolve routes without exposing the relay URL in UI errors.
    static func candidates(from relayURL: String) -> [URL] {
        relayResolveCandidates(
            from: relayURL,
            route: ["v1", "pairing", "code", "resolve"],
            includePathPreservingRoute: true
        )
    }
}

private func relayResolveCandidates(
    from relayURL: String,
    route: [String],
    includePathPreservingRoute: Bool
) -> [URL] {
    guard var components = URLComponents(string: relayURL) else {
        return []
    }

    normalizeRelayResolveComponents(&components)

    var candidates: [URL] = []
    let pathComponents = components.path.split(separator: "/").map(String.init)

    if includePathPreservingRoute, !pathComponents.isEmpty {
        var preservingComponents = components
        preservingComponents.path = "/" + (pathComponents + route).joined(separator: "/")
        appendUniqueURL(preservingComponents.url, to: &candidates)
    }

    var proxyComponents = components
    if pathComponents.last == "relay" {
        let prefix = pathComponents.dropLast()
        proxyComponents.path = "/" + (prefix + route).joined(separator: "/")
    } else {
        proxyComponents.path = "/" + route.joined(separator: "/")
    }
    appendUniqueURL(proxyComponents.url, to: &candidates)

    var rootComponents = components
    rootComponents.path = "/" + route.joined(separator: "/")
    appendUniqueURL(rootComponents.url, to: &candidates)

    return candidates
}

private func normalizeRelayResolveComponents(_ components: inout URLComponents) {
    if components.scheme == "wss" {
        components.scheme = "https"
    } else if components.scheme == "ws" {
        components.scheme = "http"
    }
    components.query = nil
    components.fragment = nil
}

private func appendUniqueURL(_ url: URL?, to candidates: inout [URL]) {
    guard let url,
          !candidates.contains(where: { $0.absoluteString == url.absoluteString }) else {
        return
    }
    candidates.append(url)
}


extension CodexService {
    // Resolves the live relay session for the preferred trusted Mac before we reconnect the socket.
    func resolveTrustedMacSessionImpl(deviceId: String? = nil) async throws -> CodexTrustedSessionResolveResponse {
        guard let trustedMac = trustedMacRecord(for: deviceId) ?? currentTrustedMacRecord else {
            throw CodexTrustedSessionResolveError.noTrustedMac
        }
        guard let relayURL = trustedMac.relayURL?.trimmingCharacters(in: .whitespacesAndNewlines),
              !relayURL.isEmpty else {
            throw CodexTrustedSessionResolveError.noTrustedMac
        }
        let resolveURLs = CodexTrustedSessionResolveURLBuilder.candidates(from: relayURL)
        guard !resolveURLs.isEmpty else {
            throw CodexTrustedSessionResolveError.invalidResponse("The trusted computer relay URL is invalid.")
        }

        var lastRetriableResolveError: CodexTrustedSessionResolveError?
        for (index, resolveURL) in resolveURLs.enumerated() {
            do {
                return try await sendTrustedSessionResolveRequest(
                    makeTrustedSessionResolveRequestBody(for: trustedMac),
                    resolveURL: resolveURL,
                    relayURL: relayURL
                )
            } catch let error as CodexTrustedSessionResolveError {
                guard shouldTryNextTrustedResolveCandidate(after: error),
                      index < resolveURLs.count - 1 else {
                    throw error
                }
                lastRetriableResolveError = error
                continue
            }
        }

        throw lastRetriableResolveError ?? CodexTrustedSessionResolveError.unsupportedRelay
    }

    private func makeTrustedSessionResolveRequestBody(
        for trustedMac: CodexTrustedMacRecord
    ) throws -> CodexTrustedSessionResolveRequest {
        let nonce = UUID().uuidString
        let timestamp = Int64(Date().timeIntervalSince1970 * 1_000)
        let transcriptBytes = codexTrustedSessionResolveTranscriptBytes(
            macDeviceId: trustedMac.macDeviceId,
            phoneDeviceId: phoneIdentityState.phoneDeviceId,
            phoneIdentityPublicKey: phoneIdentityState.phoneIdentityPublicKey,
            nonce: nonce,
            timestamp: timestamp
        )
        let phonePrivateKey = try Curve25519.Signing.PrivateKey(
            rawRepresentation: Data(base64EncodedOrEmpty: phoneIdentityState.phoneIdentityPrivateKey)
        )
        let signature = try phonePrivateKey.signature(for: transcriptBytes).base64EncodedString()

        return CodexTrustedSessionResolveRequest(
            macDeviceId: trustedMac.macDeviceId,
            phoneDeviceId: phoneIdentityState.phoneDeviceId,
            phoneIdentityPublicKey: phoneIdentityState.phoneIdentityPublicKey,
            nonce: nonce,
            timestamp: timestamp,
            signature: signature
        )
    }

    private func shouldTryNextTrustedResolveCandidate(after error: CodexTrustedSessionResolveError) -> Bool {
        switch error {
        case .unsupportedRelay, .invalidResponse, .network:
            return true
        case .macOffline, .rePairRequired, .noTrustedMac:
            return false
        }
    }

    private func sendTrustedSessionResolveRequest(
        _ requestBody: CodexTrustedSessionResolveRequest,
        resolveURL: URL,
        relayURL: String
    ) async throws -> CodexTrustedSessionResolveResponse {
        var request = URLRequest(url: resolveURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(requestBody)

        let session = trustedSessionResolveURLSession(for: resolveURL)
        defer { session.invalidateAndCancel() }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            let nsError = error as NSError
            if Task.isCancelled
                || (nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled) {
                throw CancellationError()
            }
            throw CodexTrustedSessionResolveError.network("Could not reach the trusted computer relay. Check your connection and try again.")
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw CodexTrustedSessionResolveError.invalidResponse("The trusted computer relay returned an invalid response.")
        }

        if (200..<300).contains(httpResponse.statusCode) {
            guard let resolved = try? JSONDecoder().decode(CodexTrustedSessionResolveResponse.self, from: data),
                  resolved.ok else {
                throw CodexTrustedSessionResolveError.invalidResponse("The trusted computer relay returned malformed session data.")
            }
            applyResolvedTrustedSession(resolved, relayURL: relayURL)
            return resolved
        }

        let errorResponse = try? JSONDecoder().decode(CodexRelayErrorResponse.self, from: data)
        switch errorResponse?.code {
        case "session_unavailable":
            secureConnectionState = .liveSessionUnresolved
            throw CodexTrustedSessionResolveError.macOffline("Your trusted computer is offline right now.")
        case "phone_not_trusted", "invalid_signature":
            secureConnectionState = .rePairRequired
            throw CodexTrustedSessionResolveError.rePairRequired(
                "This iPhone is no longer trusted by the paired computer. Scan a new QR code to reconnect."
            )
        case "resolve_request_replayed", "resolve_request_expired":
            throw CodexTrustedSessionResolveError.network(
                "The trusted reconnect request expired. Try reconnecting again."
            )
        default:
            if httpResponse.statusCode == 404 {
                throw CodexTrustedSessionResolveError.unsupportedRelay
            }
            throw CodexTrustedSessionResolveError.network(
                errorResponse?.error
                ?? "The trusted computer relay could not resolve the current bridge session."
            )
        }
    }

    func rememberResolvedTrustedSession(_ resolved: CodexTrustedSessionResolveResponse, relayURL: String) {
        SecureStore.writeString(resolved.sessionId, for: CodexSecureKeys.relaySessionId)
        SecureStore.writeString(relayURL, for: CodexSecureKeys.relayUrl)
        SecureStore.writeString(resolved.macDeviceId, for: CodexSecureKeys.relayMacDeviceId)
        SecureStore.writeString(resolved.macIdentityPublicKey, for: CodexSecureKeys.relayMacIdentityPublicKey)
        SecureStore.writeString(String(codexSecureProtocolVersion), for: CodexSecureKeys.relayProtocolVersion)
        relaySessionId = resolved.sessionId
        relayUrl = relayURL
        relayMacDeviceId = resolved.macDeviceId
        relayMacIdentityPublicKey = resolved.macIdentityPublicKey
        relayProtocolVersion = codexSecureProtocolVersion
        shouldForceQRBootstrapOnNextHandshake = false
        trustedReconnectFailureCount = 0
        secureConnectionState = .trustedMac
        secureMacFingerprint = codexSecureFingerprint(for: resolved.macIdentityPublicKey)
        if normalizedCurrentTrustedMacDeviceId == nil
            || normalizedCurrentTrustedMacDeviceId == resolved.macDeviceId {
            setCurrentTrustedMacDeviceId(resolved.macDeviceId)
        }
        SecureStore.writeString(resolved.macDeviceId, for: CodexSecureKeys.lastTrustedMacDeviceId)
        lastTrustedMacDeviceId = resolved.macDeviceId

        if var trustedMac = trustedMacRegistry.records[resolved.macDeviceId] {
            trustedMac.relayURL = relayURL
            trustedMac.displayName = resolved.displayName ?? trustedMac.displayName
            trustedMac.lastResolvedSessionId = resolved.sessionId
            trustedMac.lastResolvedAt = Date()
            trustedMac.lastUsedAt = Date()
            trustedMacRegistry.records[resolved.macDeviceId] = trustedMac
            SecureStore.writeCodable(trustedMacRegistry, for: CodexSecureKeys.trustedMacRegistry)
        }
    }

    var preferredPairingCodeRelayURL: String? {
        if let normalizedRelayURL {
            return normalizedRelayURL
        }
        if let trustedRelayURL = preferredTrustedMacRecord?.relayURL?.trimmingCharacters(in: .whitespacesAndNewlines),
           !trustedRelayURL.isEmpty {
            return trustedRelayURL
        }
        let defaultRelayURL = AppEnvironment.relayBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        return defaultRelayURL.isEmpty ? nil : defaultRelayURL
    }

    func sendPairingCodeResolveRequest(
        code: String,
        relayURL: String,
        resolveURL: URL
    ) async throws -> CodexPairingQRPayload {
        var request = URLRequest(url: resolveURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["code": code])

        let session = trustedSessionResolveURLSession(for: resolveURL)
        defer { session.invalidateAndCancel() }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw CodexSecureTransportError.invalidQR("Could not reach the relay for this pairing code. Try again or scan the QR code.")
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw CodexSecureTransportError.invalidQR("The relay returned an invalid response for this pairing code.")
        }

        if (200..<300).contains(httpResponse.statusCode),
           let resolved = try? JSONDecoder().decode(CodexPairingCodeResolveResponse.self, from: data),
           resolved.ok {
            return CodexPairingQRPayload(
                v: resolved.v,
                relay: relayURL,
                sessionId: resolved.sessionId,
                macDeviceId: resolved.macDeviceId,
                macIdentityPublicKey: resolved.macIdentityPublicKey,
                expiresAt: resolved.expiresAt
            )
        }

        let errorResponse = try? JSONDecoder().decode(CodexRelayErrorResponse.self, from: data)
        switch errorResponse?.code {
        case "pairing_code_expired":
            throw CodexSecureTransportError.invalidQR("This pairing code has expired. Generate a new one from the computer bridge.")
        case "pairing_code_unavailable":
            throw CodexSecureTransportError.invalidQR("That pairing code is not available right now. Make sure your computer bridge is running and try again.")
        default:
            if httpResponse.statusCode == 404 {
                throw CodexSecureTransportError.invalidQR("This relay does not support pairing codes yet. Scan the QR code instead.")
            }
            throw CodexSecureTransportError.invalidQR(
                errorResponse?.error ?? "The relay could not resolve that pairing code."
            )
        }
    }

    func shouldTryNextPairingCodeResolveCandidate(after error: CodexSecureTransportError) -> Bool {
        guard case .invalidQR(let message) = error else {
            return false
        }
        return message == "This relay does not support pairing codes yet. Scan the QR code instead."
            || message == "Could not reach the relay for this pairing code. Try again or scan the QR code."
    }

    // Uses a non-proxying URLSession for local/private-overlay relays so trusted reconnect
    // avoids the same iOS proxy path that can break direct websocket pairing.
    private func trustedSessionResolveURLSession(for url: URL) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.allowsCellularAccess = true
        configuration.allowsConstrainedNetworkAccess = true
        configuration.allowsExpensiveNetworkAccess = true

        if prefersDirectRelayTransport(for: url) {
            configuration.connectionProxyDictionary = [:]
        }

        return URLSession(configuration: configuration)
    }

}
