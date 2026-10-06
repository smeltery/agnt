// FILE: CodexService+Transport.swift
// Purpose: Outbound JSON-RPC transport and pending-response coordination.
// Layer: Service
// Exports: CodexService transport internals
// Depends on: Foundation, Network

import Foundation
import Network

// Keeps encrypted relay envelopes under one explicit ceiling across all iPhone websocket APIs.
// Image-heavy thread history and secure-envelope overhead can legitimately exceed 4 MB while
// reopening a chat, so the limit needs enough headroom for background `thread/read` catches too.
let codexWebSocketMaximumMessageSizeBytes = 16 * 1024 * 1024

extension CodexService {
    // Rejects oversized relay frames before Network.framework turns them into a raw EMSGSIZE failure.
    func validateOutgoingWebSocketMessageSize(_ text: String) throws {
        let payloadSize = Data(text.utf8).count
        guard payloadSize <= codexWebSocketMaximumMessageSizeBytes else {
            throw CodexServiceError.invalidInput(
                "This payload is too large for the relay connection. Try fewer or smaller images and retry."
            )
        }
    }

    // Sends an RPC request and waits for the matching response by request id.
    // Optional per-call timeout is reserved for non-critical reads that can fail open.
    func sendRequest(
        method: String,
        params: JSONValue?,
        timeoutNanoseconds: UInt64? = nil,
        timeoutMessage: String? = nil,
        onDispatch: (() -> Void)? = nil
    ) async throws -> RPCMessage {
        if let requestTransportOverride {
            onDispatch?()
            return try await requestTransportOverride(method, params)
        }

        guard isConnected, webSocketConnection != nil || webSocketTask != nil else {
            throw CodexServiceError.disconnected
        }

        let requestID: JSONValue = .string(UUID().uuidString)
        let requestKey = idKey(from: requestID)

        let request = RPCMessage(
            id: requestID,
            method: method,
            params: params,
            includeJSONRPC: false
        )

        if method == "turn/start",
           let collaborationMode = params?.objectValue?["collaborationMode"]?.objectValue?["mode"]?.stringValue {
            debugRuntimeLog(
                "rpc send turn/start collaborationMode=\(collaborationMode) thread=\(params?.objectValue?["threadId"]?.stringValue ?? "")"
            )
        }

        try Task.checkCancellation()

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pendingRequests[requestKey] = continuation
                scheduleRequestTimeoutIfNeeded(
                    requestKey: requestKey,
                    method: method,
                    timeoutNanoseconds: timeoutNanoseconds,
                    timeoutMessage: timeoutMessage
                )

                Task {
                    do {
                        onDispatch?()
                        try await sendMessage(request)
                    } catch {
                        if shouldTreatSendFailureAsDisconnect(error) {
                            handleReceiveError(error)
                            return
                        }

                        // Avoid double-resume if the request was already completed
                        // (for example by a disconnect race that fails all pending requests).
                        if let pendingContinuation = pendingRequests.removeValue(forKey: requestKey) {
                            pendingContinuation.resume(throwing: error)
                        }
                    }
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self,
                      let continuation = self.pendingRequests.removeValue(forKey: requestKey) else {
                    return
                }
                continuation.resume(throwing: CancellationError())
            }
        }
    }

    // Clears a still-pending request after the caller's timeout so late responses are ignored safely.
    func scheduleRequestTimeoutIfNeeded(
        requestKey: String,
        method: String,
        timeoutNanoseconds: UInt64?,
        timeoutMessage: String? = nil
    ) {
        guard let timeoutNanoseconds, timeoutNanoseconds > 0 else {
            return
        }

        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: timeoutNanoseconds)
            guard let self,
                  let continuation = self.pendingRequests.removeValue(forKey: requestKey) else {
                return
            }
            let message = timeoutMessage ?? "\(method) timed out while loading this chat."
            continuation.resume(
                throwing: CodexServiceError.invalidInput(message)
            )
        }
    }

    // Sends a fire-and-forget RPC notification.
    func sendNotification(method: String, params: JSONValue?) async throws {
        let notification = RPCMessage(
            jsonrpc: nil,
            id: nil,
            method: method,
            params: params,
            result: nil,
            error: nil
        )

        try await sendMessage(notification)
    }

    // Sends an RPC response for a server-initiated request.
    func sendResponse(id: JSONValue, result: JSONValue) async throws {
        let response = RPCMessage(id: id, result: result, includeJSONRPC: false)
        try await sendMessage(response)
    }

    // Sends an RPC error response for unsupported or invalid server requests.
    func sendErrorResponse(id: JSONValue?, code: Int, message: String, data: JSONValue? = nil) async throws {
        let rpcError = RPCError(code: code, message: message, data: data)
        let response = RPCMessage(id: id, error: rpcError, includeJSONRPC: false)
        try await sendMessage(response)
    }

    func sendMessage(_ message: RPCMessage) async throws {
        let payload = try encoder.encode(message)
        guard let plaintext = String(data: payload, encoding: .utf8) else {
            throw CodexServiceError.invalidResponse("Unable to encode outgoing JSON-RPC payload")
        }

        let secureText = try secureWireText(for: plaintext)
        try await sendRawText(secureText)
    }

    // Sends raw secure control messages before the JSON-RPC channel is initialized.
    func sendRawText(_ text: String) async throws {
        try validateOutgoingWebSocketMessageSize(text)

        if usesManualWebSocketTransport {
            guard let connection = webSocketConnection else {
                throw CodexServiceError.disconnected
            }
            try await sendManualWebSocketFrame(opcode: 0x1, payload: Data(text.utf8), on: connection)
            return
        }

        if let task = webSocketTask {
            try await task.send(.string(text))
            return
        }

        guard let connection = webSocketConnection else {
            throw CodexServiceError.disconnected
        }

        let payload = Data(text.utf8)
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "codex-jsonrpc", metadata: [metadata])

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(
                content: payload,
                contentContext: context,
                isComplete: true,
                completion: .contentProcessed { error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(returning: ())
                    }
                }
            )
        }
    }


    func failAllPendingRequests(with error: Error) {
        let continuations = pendingRequests
        pendingRequests.removeAll()

        for continuation in continuations.values {
            continuation.resume(throwing: error)
        }
    }

    func idKey(from id: JSONValue) -> String {
        switch id {
        case .string(let value):
            return "s:\(value)"
        case .integer(let value):
            return "i:\(value)"
        case .double(let value):
            return "d:\(value)"
        case .bool(let value):
            return "b:\(value)"
        case .null:
            return "null"
        case .object, .array:
            return "complex:\(String(describing: id))"
        }
    }
}
