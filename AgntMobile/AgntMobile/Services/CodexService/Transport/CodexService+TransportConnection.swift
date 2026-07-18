// FILE: CodexService+TransportConnection.swift
// Purpose: Establishes websocket transports and normalizes connection readiness/error diagnostics.
// Layer: Service
// Exports: CodexService websocket connection establishment helpers
// Depends on: Foundation, Network, os

import Foundation
import Network
import os

private enum CodexRelayTransportPreference {
    case manualTCP
    case networkWebSocket

    var logLabel: String {
        switch self {
        case .manualTCP:
            return "manual TCP websocket"
        case .networkWebSocket:
            return "NWConnection websocket"
        }
    }
}

private struct CodexConnectionReadyWaitConfiguration {
    let logLabel: String
    let timeoutNanoseconds: UInt64
    let timeoutMessage: String
}

private struct CodexManualWebSocketEndpoint {
    let host: String
    let port: NWEndpoint.Port
    let scheme: String
}

nonisolated func codexLogPairingTransport(_ message: String) {
    print("[PAIRING] \(message)")
}

extension CodexService {
    func establishWebSocketConnection(url: URL, token: String, role: String? = nil) async throws -> CodexWebSocketTransport {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss" else {
            throw CodexServiceError.invalidServerURL(url.absoluteString)
        }

        let preference = relayTransportPreference(for: url)
        codexLogPairingTransport("using \(preference.logLabel) for \(url.host ?? "unknown-host")")

        switch preference {
        case .manualTCP:
            return try await establishManualTCPWebSocketConnection(url: url, token: token, role: role)
        case .networkWebSocket:
            return try await establishNWWebSocketConnection(url: url, token: token, role: role)
        }
    }

    // Mirrors litter's raw TCP websocket client so LAN/private-overlay pairing can bypass iOS proxy/WebSocket API bugs.
    func establishManualTCPWebSocketConnection(
        url: URL,
        token: String,
        role: String? = nil
    ) async throws -> CodexWebSocketTransport {
        let endpoint = try manualWebSocketEndpoint(from: url)

        let parameters = NWParameters(
            tls: (endpoint.scheme == "wss") ? NWProtocolTLS.Options() : nil,
            tcp: NWProtocolTCP.Options()
        )
        let connection = NWConnection(host: NWEndpoint.Host(endpoint.host), port: endpoint.port, using: parameters)
        let waitConfiguration = CodexConnectionReadyWaitConfiguration(
            logLabel: "manual TCP websocket",
            timeoutNanoseconds: 12_000_000_000,
            timeoutMessage: "Connection timed out after 12s while opening the direct relay socket."
        )

        codexLogPairingTransport("opening manual TCP websocket")
        try await waitUntilManualConnectionReady(connection, configuration: waitConfiguration)
        do {
            try await performManualWebSocketHandshake(on: connection, url: url, token: token, role: role)
            codexLogPairingTransport("manual TCP websocket connected")
        } catch {
            connection.cancel()
            throw error
        }

        connection.stateUpdateHandler = { [weak self] state in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard self.webSocketConnection === connection, self.usesManualWebSocketTransport else { return }

                switch state {
                case .failed(let error):
                    self.handleReceiveError(error)
                case .cancelled:
                    if self.isConnected {
                        self.handleReceiveError(CodexServiceError.disconnected)
                    }
                default:
                    break
                }
            }
        }

        return .manualTCP(connection)
    }

    // Uses Network.framework directly for remote relays and as a fallback when URLSession
    // misclassifies a reachable local relay as offline before sending any upgrade request.
    func establishNWWebSocketConnection(
        url: URL,
        token: String,
        role: String? = nil
    ) async throws -> CodexWebSocketTransport {
        let scheme = (url.scheme ?? "ws").lowercased()
        let webSocketOptions = NWProtocolWebSocket.Options()
        webSocketOptions.autoReplyPing = true
        // Network.framework defaults this low enough to reject larger encrypted envelopes.
        webSocketOptions.maximumMessageSize = codexWebSocketMaximumMessageSizeBytes

        var additionalHeaders: [(name: String, value: String)] = []
        if let role, !role.isEmpty {
            additionalHeaders.append((name: "x-role", value: role))
        } else if !token.isEmpty {
            additionalHeaders.append((name: "Authorization", value: "Bearer \(token)"))
        }
        if !additionalHeaders.isEmpty {
            webSocketOptions.setAdditionalHeaders(additionalHeaders)
        }

        let tlsOptions: NWProtocolTLS.Options? = (scheme == "wss") ? NWProtocolTLS.Options() : nil
        let parameters = NWParameters(tls: tlsOptions, tcp: NWProtocolTCP.Options())
        parameters.defaultProtocolStack.applicationProtocols.insert(webSocketOptions, at: 0)

        codexLogPairingTransport("opening NWConnection websocket")
        let connection = NWConnection(to: .url(url), using: parameters)
        let waitConfiguration = CodexConnectionReadyWaitConfiguration(
            logLabel: "NWConnection websocket",
            timeoutNanoseconds: 12_000_000_000,
            timeoutMessage: "Connection timed out after 12s while opening the relay websocket."
        )

        try await waitUntilConnectionReady(connection, configuration: waitConfiguration)

        connection.stateUpdateHandler = { [weak self] state in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard self.webSocketConnection === connection else { return }

                switch state {
                case .failed(let error):
                    self.handleReceiveError(error)
                case .cancelled:
                    if self.isConnected {
                        self.handleReceiveError(CodexServiceError.disconnected)
                    }
                default:
                    break
                }
            }
        }

        return .network(connection)
    }

    // Uses URLSession for LAN relay sockets because NWConnection has been unreliable
    // on some iOS builds for local ws:// endpoints even when the relay is reachable.
    func establishURLSessionWebSocketConnection(
        url: URL,
        token: String,
        role: String? = nil
    ) async throws -> CodexWebSocketTransport {
        var request = URLRequest(url: url)
        if let role, !role.isEmpty {
            request.setValue(role, forHTTPHeaderField: "x-role")
        } else if !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let configuration = URLSessionConfiguration.default
        // Local relay sockets should fail fast if the LAN path is unusable instead of
        // waiting indefinitely for a "better" connectivity state that never starts the upgrade.
        configuration.waitsForConnectivity = false
        configuration.allowsCellularAccess = true
        configuration.allowsConstrainedNetworkAccess = true
        configuration.allowsExpensiveNetworkAccess = true
        let delegate = CodexURLSessionWebSocketDelegate()
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = codexWebSocketMaximumMessageSizeBytes
        let connectionTimeoutNanoseconds: UInt64 = 12_000_000_000

        codexLogPairingTransport("opening URLSessionWebSocketTask")
        task.resume()
        webSocketSessionDelegate = delegate

        let timeoutTask = Task { [weak task, weak delegate] in
            try? await Task.sleep(nanoseconds: connectionTimeoutNanoseconds)
            guard !Task.isCancelled else { return }
            task?.cancel(with: .goingAway, reason: nil)
            delegate?.resolveOpen(
                with: .failure(CodexServiceError.invalidInput("Connection timed out after 12s"))
            )
        }
        defer { timeoutTask.cancel() }

        do {
            try await delegate.waitForOpen()
            codexLogPairingTransport("URLSessionWebSocketTask connected")
        } catch {
            codexLogPairingTransport("URLSessionWebSocketTask failed: \(urlSessionWebSocketDebugDescription(for: error))")
            task.cancel(with: .goingAway, reason: nil)
            session.invalidateAndCancel()
            webSocketSessionDelegate = nil
            throw error
        }

        return .urlSession(session, task)
    }

    func relayCloseCode(for closeCode: URLSessionWebSocketTask.CloseCode) -> NWProtocolWebSocket.CloseCode? {
        guard closeCode != .invalid else {
            return nil
        }

        let rawValue = closeCode.rawValue
        if rawValue >= 4000 {
            return .privateCode(UInt16(rawValue))
        }
        if rawValue >= 3000 {
            return .applicationCode(UInt16(rawValue))
        }
        return nil
    }

    // Extracts CFNetwork/NWPath hints from websocket failures so local relay bugs are diagnosable on device.
    func urlSessionWebSocketDebugDescription(for error: Error) -> String {
        let nsError = error as NSError
        let pathDescription = nsError.userInfo["_NSURLErrorNWPathKey"] as? String
        let underlyingError = nsError.userInfo[NSUnderlyingErrorKey] as? NSError

        var parts = ["\(error)"]
        if let pathDescription, !pathDescription.isEmpty {
            parts.append("nwPath=\(pathDescription)")
        }
        if let underlyingError {
            parts.append("underlying=\(underlyingError.domain)(\(underlyingError.code)) \(underlyingError.localizedDescription)")
        }
        return parts.joined(separator: " | ")
    }

    fileprivate func relayTransportPreference(for url: URL) -> CodexRelayTransportPreference {
        prefersDirectRelayTransport(for: url) ? .manualTCP : .networkWebSocket
    }

    fileprivate func manualWebSocketEndpoint(from url: URL) throws -> CodexManualWebSocketEndpoint {
        guard let host = url.host else {
            throw CodexServiceError.invalidServerURL(url.absoluteString)
        }

        let scheme = (url.scheme ?? "ws").lowercased()
        let defaultPort: UInt16 = (scheme == "wss") ? 443 : 80
        guard let port = NWEndpoint.Port(rawValue: UInt16(url.port ?? Int(defaultPort))) else {
            throw CodexServiceError.invalidServerURL(url.absoluteString)
        }

        return CodexManualWebSocketEndpoint(host: host, port: port, scheme: scheme)
    }

    // Waits for plain TCP readiness before sending the manual websocket upgrade request.
    fileprivate func waitUntilManualConnectionReady(
        _ connection: NWConnection,
        configuration: CodexConnectionReadyWaitConfiguration
    ) async throws {
        try await waitUntilConnectionReady(connection, configuration: configuration)
    }

    // Normalizes the one-shot NWConnection wait flow so timeout/cancel races surface a useful cause.
    fileprivate func waitUntilConnectionReady(
        _ connection: NWConnection,
        configuration: CodexConnectionReadyWaitConfiguration
    ) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            // Shared mutable state across the NW callback (webSocketQueue) and the timeout Task.
            // OSAllocatedUnfairLock is async-safe (unlike NSLock) and serializes every access.
            struct WaitState: Sendable {
                var didFinish = false
                var timeoutTask: Task<Void, Never>?
                var lastObservedStateDescription = "setup"
                var lastWaitingErrorDescription: String?
            }
            let lockedState = OSAllocatedUnfairLock(initialState: WaitState())

            @Sendable func finish(_ result: Result<Void, Error>) {
                let shouldResume = lockedState.withLock { state -> Bool in
                    guard !state.didFinish else { return false }
                    state.didFinish = true
                    state.timeoutTask?.cancel()
                    return true
                }
                guard shouldResume else { return }
                continuation.resume(with: result)
                // Ignore future state transitions after first completion.
                connection.stateUpdateHandler = { _ in }
            }

            connection.stateUpdateHandler = { nwState in
                lockedState.withLock { state in
                    state.lastObservedStateDescription = String(describing: nwState)
                    if case .waiting(let error) = nwState {
                        state.lastWaitingErrorDescription = String(describing: error)
                    }
                }

                codexLogPairingTransport("\(configuration.logLabel) state: \(nwState)")
                switch nwState {
                case .ready:
                    finish(.success(()))
                case .waiting:
                    break
                case .failed(let error):
                    codexLogPairingTransport("\(configuration.logLabel) failed: \(error)")
                    finish(.failure(error))
                case .cancelled:
                    finish(.failure(CodexServiceError.disconnected))
                default:
                    break
                }
            }

            connection.start(queue: webSocketQueue)
            let task = Task { [weak connection] in
                try? await Task.sleep(nanoseconds: configuration.timeoutNanoseconds)
                guard !Task.isCancelled else { return }
                let timeoutError = CodexServiceError.invalidInput(configuration.timeoutMessage)
                let (observedState, waitingError) = lockedState.withLock { state in
                    (state.lastObservedStateDescription, state.lastWaitingErrorDescription)
                }
                var timeoutLog = "\(configuration.logLabel) timed out while state=\(observedState)"
                if let waitingError {
                    timeoutLog += " waitingError=\(waitingError)"
                }
                codexLogPairingTransport(timeoutLog)
                finish(.failure(timeoutError))
                connection?.cancel()
            }
            lockedState.withLock { $0.timeoutTask = task }
        }
    }
}
