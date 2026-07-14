// FILE: CodexService+TransportReceive.swift
// Purpose: Receives websocket frames from Network, URLSession, and manual TCP transports.
// Layer: Service
// Exports: CodexService transport receive loops
// Depends on: Foundation, Network

import Foundation
import Network

extension CodexService {
    func startReceiveLoop(with connection: NWConnection) {
        receiveNextMessage(on: connection)
    }

    func startReceiveLoop(with task: URLSessionWebSocketTask) {
        receiveNextMessage(on: task)
    }

    // Reads raw TCP bytes and drains manual websocket frames for the relay LAN fallback.
    func startManualReceiveLoop(with connection: NWConnection) {
        receiveNextManualChunk(on: connection)
    }

    func receiveNextMessage(on connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self else { return }

            // Pre-decode wire text off the main actor so JSONDecoder doesn't block UI frames.
            let wireText: String? = data.flatMap { String(data: $0, encoding: .utf8) }
            let preDecoded = wireText.map { WireMessagePreDecoder.classify($0) }

            Task { @MainActor [weak self] in
                guard let self else { return }
                guard self.webSocketConnection === connection else { return }

                if let error {
                    self.handleReceiveError(error)
                    return
                }

                if let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata,
                   metadata.opcode == .close {
                    self.handleReceiveError(
                        CodexServiceError.disconnected,
                        relayCloseCode: metadata.closeCode
                    )
                    return
                }

                if let text = wireText, let decoded = preDecoded {
                    if decoded.isSecure {
                        // Secure control or encrypted envelope — must stay on MainActor.
                        self.processIncomingWireText(text)
                    } else if let rpcResult = decoded.rpcResult {
                        self.handleDecodedRPCResult(rpcResult, rawText: text)
                    }
                }

                self.receiveNextMessage(on: connection)
            }
        }
    }

    func receiveNextManualChunk(on connection: NWConnection) {
        receiveRaw(on: connection) { [weak self] result in
            guard let self else { return }

            Task { @MainActor [weak self] in
                guard let self else { return }
                guard self.webSocketConnection === connection, self.usesManualWebSocketTransport else { return }

                switch result {
                case .failure(let error):
                    self.handleReceiveError(error)
                case .success(nil):
                    self.handleReceiveError(CodexServiceError.disconnected)
                case .success(let data?):
                    if !data.isEmpty {
                        self.manualWebSocketReadBuffer.append(data)
                        do {
                            let didHandleClose = try await self.drainManualWebSocketFrames(on: connection)
                            if didHandleClose {
                                return
                            }
                        } catch {
                            self.handleReceiveError(error)
                            return
                        }
                    }
                    self.receiveNextManualChunk(on: connection)
                }
            }
        }
    }

    func receiveNextMessage(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }

            // Extract text and pre-decode off the main actor.
            // Bind as `let` so Swift 6 strict concurrency allows capture into the @MainActor Task below.
            let wireText: String? = {
                guard case .success(let message) = result else { return nil }
                switch message {
                case .string(let text): return text
                case .data(let data): return String(data: data, encoding: .utf8)
                @unknown default: return nil
                }
            }()
            let preDecoded = wireText.flatMap(WireMessagePreDecoder.classify)

            Task { @MainActor [weak self] in
                guard let self else { return }
                guard self.webSocketTask === task else { return }

                switch result {
                case .failure(let error):
                    self.handleReceiveError(
                        error,
                        relayCloseCode: self.relayCloseCode(for: task.closeCode)
                    )
                case .success:
                    if let text = wireText, let decoded = preDecoded {
                        if decoded.isSecure {
                            self.processIncomingWireText(text)
                        } else if let rpcResult = decoded.rpcResult {
                            self.handleDecodedRPCResult(rpcResult, rawText: text)
                        }
                    }

                    self.receiveNextMessage(on: task)
                }
            }
        }
    }
}
