// FILE: CodexService+ManualWebSocket.swift
// Purpose: Implements the raw TCP websocket handshake and frame codec used by direct relay pairing.
// Layer: Service
// Exports: CodexService manual websocket helpers
// Depends on: CryptoKit, Foundation, Network, Security

import CryptoKit
import Foundation
import Network
import Security

extension CodexService {
    // Builds the HTTP upgrade request manually so LAN pairing avoids higher-level websocket APIs.
    func performManualWebSocketHandshake(
        on connection: NWConnection,
        url: URL,
        token: String,
        role: String?
    ) async throws {
        let key = randomManualWebSocketKey()
        let path = manualWebSocketPath(from: url)
        let hostHeader = url.port.map { "\(url.host ?? ""):\($0)" } ?? (url.host ?? "")
        var requestLines = [
            "GET \(path) HTTP/1.1",
            "Host: \(hostHeader)",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: \(key)",
            "Sec-WebSocket-Version: 13",
        ]
        if let role, !role.isEmpty {
            requestLines.append("x-role: \(role)")
        } else if !token.isEmpty {
            requestLines.append("Authorization: Bearer \(token)")
        }
        requestLines.append(contentsOf: ["", ""])

        codexLogPairingTransport("sending manual TCP websocket upgrade request")
        try await sendRaw(Data(requestLines.joined(separator: "\r\n").utf8), on: connection)

        var headerBytes = Data()
        while true {
            if let range = headerBytes.range(of: Data("\r\n\r\n".utf8)) {
                let headerData = Data(headerBytes[..<range.upperBound])
                manualWebSocketReadBuffer = Data(headerBytes[range.upperBound...])
                try validateManualWebSocketHandshakeResponse(headerData: headerData, key: key)
                codexLogPairingTransport("manual TCP websocket upgrade accepted")
                return
            }
            guard let chunk = try await receiveRaw(on: connection) else {
                throw CodexServiceError.disconnected
            }
            headerBytes.append(chunk)
            if headerBytes.count > 65_536 {
                throw CodexServiceError.invalidInput("Relay handshake response was too large")
            }
        }
    }

    func manualWebSocketPath(from url: URL) -> String {
        let base = url.path.isEmpty ? "/" : url.path
        if let query = url.query, !query.isEmpty {
            return "\(base)?\(query)"
        }
        return base
    }

    func randomManualWebSocketKey() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString()
    }

    func validateManualWebSocketHandshakeResponse(headerData: Data, key: String) throws {
        guard let headerText = String(data: headerData, encoding: .utf8) else {
            throw CodexServiceError.invalidInput("Relay handshake response could not be decoded")
        }

        let lines = headerText.components(separatedBy: "\r\n")
        guard let status = lines.first, status.contains(" 101 ") else {
            throw CodexServiceError.invalidInput("Relay rejected websocket upgrade")
        }

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let separatorIndex = line.firstIndex(of: ":") else { continue }
            let name = line[..<separatorIndex].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let value = line[line.index(after: separatorIndex)...].trimmingCharacters(in: .whitespacesAndNewlines)
            headers[name] = value
        }

        let acceptSeed = "\(key)258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        let expectedAccept = Data(Insecure.SHA1.hash(data: Data(acceptSeed.utf8))).base64EncodedString()
        guard headers["sec-websocket-accept"] == expectedAccept else {
            throw CodexServiceError.invalidInput("Relay returned an invalid websocket accept key")
        }
    }

    // Preserves relay close semantics on the raw TCP websocket path so `.local` reconnects
    // reuse the same retry / re-pair policy as the higher-level websocket transports.
    func drainManualWebSocketFrames(on connection: NWConnection) async throws -> Bool {
        while let frame = parseManualWebSocketFrame(from: &manualWebSocketReadBuffer) {
            switch frame.opcode {
            case 0x1:
                if let text = String(data: frame.payload, encoding: .utf8) {
                    lastRawMessage = text
                    processIncomingWireText(text)
                }
            case 0x8:
                handleReceiveError(
                    CodexServiceError.disconnected,
                    relayCloseCode: relayCloseCode(fromManualWebSocketClosePayload: frame.payload)
                )
                return true
            case 0x9:
                try await sendManualWebSocketFrame(opcode: 0xA, payload: frame.payload, on: connection)
            case 0xA:
                break
            default:
                break
            }
        }

        return false
    }

    func parseManualWebSocketFrame(from buffer: inout Data) -> (opcode: UInt8, payload: Data)? {
        guard buffer.count >= 2 else { return nil }

        let firstByte = buffer[buffer.startIndex]
        let secondByte = buffer[buffer.startIndex + 1]
        let opcode = firstByte & 0x0F
        let masked = (secondByte & 0x80) != 0

        var index = 2
        var payloadLength = Int(secondByte & 0x7F)
        if payloadLength == 126 {
            guard buffer.count >= index + 2 else { return nil }
            payloadLength = Int(buffer[index]) << 8 | Int(buffer[index + 1])
            index += 2
        } else if payloadLength == 127 {
            guard buffer.count >= index + 8 else { return nil }
            var decodedLength: UInt64 = 0
            for offset in 0..<8 {
                decodedLength = (decodedLength << 8) | UInt64(buffer[index + offset])
            }
            guard decodedLength <= UInt64(Int.max) else { return nil }
            payloadLength = Int(decodedLength)
            index += 8
        }

        var maskKey = Data()
        if masked {
            guard buffer.count >= index + 4 else { return nil }
            maskKey = buffer.subdata(in: index..<(index + 4))
            index += 4
        }

        guard buffer.count >= index + payloadLength else { return nil }
        var payload = buffer.subdata(in: index..<(index + payloadLength))
        buffer.removeSubrange(0..<(index + payloadLength))

        if masked {
            let maskBytes = [UInt8](maskKey)
            var payloadBytes = [UInt8](payload)
            for i in payloadBytes.indices {
                payloadBytes[i] ^= maskBytes[i % 4]
            }
            payload = Data(payloadBytes)
        }

        return (opcode: opcode, payload: payload)
    }

    // Pulls relay-owned custom close codes out of raw websocket close payloads on the direct transport.
    func relayCloseCode(fromManualWebSocketClosePayload payload: Data) -> NWProtocolWebSocket.CloseCode? {
        guard payload.count >= 2 else {
            return nil
        }

        let rawValue = (UInt16(payload[payload.startIndex]) << 8) | UInt16(payload[payload.startIndex + 1])
        if rawValue >= 4000 {
            return .privateCode(rawValue)
        }
        if rawValue >= 3000 {
            return .applicationCode(rawValue)
        }

        return nil
    }

    func sendManualWebSocketFrame(opcode: UInt8, payload: Data, on connection: NWConnection) async throws {
        var frame = Data()
        frame.append(0x80 | opcode)

        let maskBit: UInt8 = 0x80
        if payload.count < 126 {
            frame.append(maskBit | UInt8(payload.count))
        } else if payload.count <= 0xFFFF {
            frame.append(maskBit | 126)
            frame.append(UInt8((payload.count >> 8) & 0xFF))
            frame.append(UInt8(payload.count & 0xFF))
        } else {
            frame.append(maskBit | 127)
            let length = UInt64(payload.count)
            for shift in stride(from: 56, through: 0, by: -8) {
                frame.append(UInt8((length >> UInt64(shift)) & 0xFF))
            }
        }

        var mask = [UInt8](repeating: 0, count: 4)
        _ = SecRandomCopyBytes(kSecRandomDefault, mask.count, &mask)
        frame.append(contentsOf: mask)
        for (index, byte) in payload.enumerated() {
            frame.append(byte ^ mask[index % 4])
        }

        try await sendRaw(frame, on: connection)
    }

    func sendRaw(_ data: Data, on connection: NWConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            })
        }
    }

    func receiveRaw(
        on connection: NWConnection,
        completion: @escaping (Result<Data?, Error>) -> Void
    ) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
            if let error {
                completion(.failure(error))
                return
            }
            if isComplete && (data == nil || data?.isEmpty == true) {
                completion(.success(nil))
                return
            }
            completion(.success(data ?? Data()))
        }
    }

    func receiveRaw(on connection: NWConnection) async throws -> Data? {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data?, Error>) in
            receiveRaw(on: connection) { result in
                continuation.resume(with: result)
            }
        }
    }
}
