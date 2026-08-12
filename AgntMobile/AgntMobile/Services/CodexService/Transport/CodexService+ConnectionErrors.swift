// FILE: CodexService+ConnectionErrors.swift
// Purpose: Connection error classification, retry policy, and user-facing copy.
// Layer: Service

import Foundation
import Network
import UIKit

extension CodexService {
    func receiveErrorDisposition(
        for error: Error,
        relayCloseCode: NWProtocolWebSocket.CloseCode?
    ) -> ReceiveErrorDisposition {
        let shouldClearSavedRelaySession = shouldClearSavedRelaySession(for: relayCloseCode)
        let shouldRetryRelayConnection = isRetryableRelayClose(relayCloseCode)
        let retryableSessionUnavailableMessage = retryableSessionUnavailableMessage(for: relayCloseCode)
        // Only relay closes that preserve the saved session should stay on this socket path;
        // stale live sessions recover through trusted resolve instead of immediate QR.
        let permanentRelayMessage = shouldClearSavedRelaySession
            ? (permanentRelayDisconnectMessage(for: relayCloseCode)
                ?? "This relay pairing is no longer valid. Scan a new QR code to reconnect.")
            : nil
        let explicitRelayDropMessage = explicitRelayDropMessage(for: relayCloseCode)
        let isBenignDisconnect = isBenignBackgroundDisconnect(error)
        let shouldSuppressMessage = isBenignDisconnect && !isActivelyForegroundedForConnectionUI()
        // Foreground relay drops should reconnect too, otherwise Stop disappears mid-run.
        let shouldAttemptAutoRecovery = !shouldClearSavedRelaySession
            && explicitRelayDropMessage == nil
            && (shouldRetryRelayConnection
                || isRecoverableTransientConnectionError(error)
                || isBenignDisconnect)

        let connectionRecoveryState: CodexConnectionRecoveryState = shouldAttemptAutoRecovery
            ? .retrying(attempt: 0, message: recoveryStatusMessage(for: error))
            : .idle

        let lastErrorMessage: String?
        if let permanentRelayMessage {
            lastErrorMessage = permanentRelayMessage
        } else if let retryableSessionUnavailableMessage, !shouldSuppressMessage {
            lastErrorMessage = retryableSessionUnavailableMessage
        } else if let explicitRelayDropMessage {
            lastErrorMessage = explicitRelayDropMessage
        } else if !shouldSuppressMessage && !shouldAttemptAutoRecovery {
            lastErrorMessage = userFacingConnectFailureMessage(error)
        } else {
            lastErrorMessage = nil
        }

        return ReceiveErrorDisposition(
            shouldClearSavedRelaySession: shouldClearSavedRelaySession,
            shouldAutoReconnectOnForeground: !shouldClearSavedRelaySession
                && (shouldSuppressMessage || shouldAttemptAutoRecovery || explicitRelayDropMessage != nil),
            connectionRecoveryState: connectionRecoveryState,
            lastErrorMessage: lastErrorMessage
        )
    }

    // Detects runtimes that still reject `initialize.capabilities`.
    func shouldRetryInitializeWithoutCapabilities(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        if rpcError.code != -32600 && rpcError.code != -32602 {
            return false
        }

        let message = rpcError.message.lowercased()
        guard message.contains("capabilities") || message.contains("experimentalapi") else {
            return false
        }

        return message.contains("unknown")
            || message.contains("unexpected")
            || message.contains("unrecognized")
            || message.contains("invalid")
            || message.contains("unsupported")
            || message.contains("field")
    }

    // Uses the documented experimental listing endpoint instead of assuming initialize implies plan support.
    func runtimeSupportsPlanCollaborationMode() async -> Bool {
        do {
            let response = try await sendRequest(
                method: "collaborationMode/list",
                params: .object([:])
            )
            return responseContainsPlanCollaborationMode(response)
        } catch {
            debugRuntimeLog("collaborationMode/list failed: \(error.localizedDescription)")
            return false
        }
    }

    // Accepts the current app-server result shapes without depending on one exact field name.
    func responseContainsPlanCollaborationMode(_ response: RPCMessage) -> Bool {
        let candidateArrays: [[JSONValue]?] = [
            response.result?.arrayValue,
            response.result?.objectValue?["data"]?.arrayValue,
            response.result?.objectValue?["modes"]?.arrayValue,
            response.result?.objectValue?["collaborationModes"]?.arrayValue,
            response.result?.objectValue?["items"]?.arrayValue,
        ]

        for candidateArray in candidateArrays {
            guard let candidateArray else { continue }
            for entry in candidateArray {
                let modeName = entry.objectValue?["mode"]?.stringValue
                    ?? entry.objectValue?["name"]?.stringValue
                    ?? entry.objectValue?["id"]?.stringValue
                    ?? entry.stringValue
                if modeName == CodexCollaborationModeKind.plan.rawValue {
                    return true
                }
            }
        }

        return false
    }

    func canonicalServerIdentity(for url: URL) -> String {
        let scheme = (url.scheme ?? "ws").lowercased()
        let host = (url.host ?? "unknown-host").lowercased()
        let defaultPort = (scheme == "wss") ? 443 : 80
        let port = url.port ?? defaultPort
        let path = url.path.isEmpty ? "/" : url.path
        return "\(scheme)://\(host):\(port)\(path)"
    }

    func validateConnectionURL(_ serverURL: String) throws -> URL {
        guard let url = URL(string: serverURL) else {
            let message = CodexServiceError.invalidServerURL(serverURL).localizedDescription
            lastErrorMessage = message
            throw CodexServiceError.invalidServerURL(serverURL)
        }

        return url
    }

    func userFacingConnectError(error: Error, attemptedURL: String, host: String?) -> String {
        if let nwError = error as? NWError {
            switch nwError {
            case .posix(let code) where code == .ECONNREFUSED:
                return "Connection refused by relay server at \(attemptedURL)."
            case .posix(let code) where code == .EMSGSIZE:
                return oversizedRelayPayloadMessage
            case .posix(let code) where code == .ENETDOWN || code == .ENETUNREACH || code == .EHOSTUNREACH:
                return "Cannot reach relay server at \(attemptedURL). Check that the iPhone can access the paired computer on the local network."
            case .posix(let code) where code == .ETIMEDOUT:
                return "Connection timed out. Check server/network."
            case .dns(let code):
                return "Cannot resolve server host (\(code)). Check the relay URL."
            default:
                break
            }
        }

        if isRecoverableTransientConnectionError(error) {
            return "Connection timed out. Check server/network."
        }

        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain,
           nsError.code == NSURLErrorNotConnectedToInternet,
           requiresLocalNetworkAuthorization(for: URL(string: attemptedURL) ?? URL(fileURLWithPath: "/")) {
            return "agnt cannot open the local relay connection on this iPhone. Check Local Network and the app's Wi-Fi/Cellular access in Settings, then retry."
        }

        return error.localizedDescription
    }

    // Treats common local relay socket teardowns as transient so foreground return can recover quietly.
    func isBenignBackgroundDisconnect(_ error: Error) -> Bool {
        if let serviceError = error as? CodexServiceError {
            if case .disconnected = serviceError {
                return true
            }
        }

        guard let nwError = error as? NWError else {
            return false
        }

        if case .posix(let code) = nwError,
           code == .ECONNABORTED
            || code == .ECANCELED
            || code == .ENOTCONN
            || code == .ENODATA
            || code == .ECONNRESET {
            return true
        }

        return false
    }

    // Treats write-side socket loss the same as receive-side disconnects so UI can recover instead of hanging.
    func shouldTreatSendFailureAsDisconnect(_ error: Error) -> Bool {
        if isBenignBackgroundDisconnect(error) || isRecoverableTransientConnectionError(error) {
            return true
        }

        guard let nwError = error as? NWError,
              case .posix(let code) = nwError else {
            return false
        }

        return code == .EPIPE || code == .ECONNRESET
    }

    func isRecoverableTransientConnectionError(_ error: Error) -> Bool {
        if let serviceError = error as? CodexServiceError {
            if case .invalidInput(let message) = serviceError {
                return message.localizedCaseInsensitiveContains("timed out")
            }
        }

        if let nwError = error as? NWError {
            if case .posix(let code) = nwError,
               code == .ETIMEDOUT {
                return true
            }
        }

        let nsError = error as NSError
        return nsError.domain == NSPOSIXErrorDomain
            && nsError.code == Int(POSIXErrorCode.ETIMEDOUT.rawValue)
    }

    // Detects connect-time relay closes that still leave the saved session reusable moments later.
    func isRetryableSavedSessionConnectError(_ error: Error) -> Bool {
        guard let rawValue = relayCloseCodeRawValue(fromConnectError: error) else {
            return false
        }

        return Self.retryableRelayCloseCodeRawValues.contains(rawValue)
    }

    // Keeps auto-recovery reconnects visually quiet, even if stale in-flight sync calls fail after the socket drops.
    func shouldSuppressRecoverableConnectionError(_ error: Error) -> Bool {
        let isRecovering: Bool
        switch connectionRecoveryState {
        case .retrying:
            isRecovering = true
        case .idle:
            isRecovering = false
        }

        guard shouldAutoReconnectOnForeground || isRecovering else {
            return false
        }

        return shouldTreatSendFailureAsDisconnect(error)
            || isBenignBackgroundDisconnect(error)
            || isRecoverableTransientConnectionError(error)
    }

    // Suppresses only background disconnect noise; foreground timeouts should still tell the user why sync stopped.
    func shouldSuppressUserFacingConnectionError(_ error: Error) -> Bool {
        shouldSuppressRecoverableConnectionError(error)
            || (isBenignBackgroundDisconnect(error) && !isActivelyForegroundedForConnectionUI())
    }

    // Surfaces only meaningful connection failures to the UI and keeps reconnect noise silent.
    func presentConnectionErrorIfNeeded(_ error: Error, fallbackMessage: String? = nil) {
        guard !shouldSuppressUserFacingConnectionError(error) else {
            return
        }

        let message = (fallbackMessage ?? userFacingConnectFailureMessage(error))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else {
            return
        }

        // Preserve a more specific relay-session message instead of replacing it with a generic disconnect.
        if message == CodexServiceError.disconnected.localizedDescription,
           let lastErrorMessage,
           !lastErrorMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return
        }

        lastErrorMessage = message
    }

    func recoveryStatusMessage(for error: Error) -> String {
        if isRetryableSavedSessionConnectError(error) {
            return "Reconnecting..."
        }
        if isRecoverableTransientConnectionError(error) {
            return "Connection timed out. Retrying..."
        }
        return "Reconnecting..."
    }

    func userFacingConnectFailureMessage(_ error: Error) -> String {
        if let retryableSessionUnavailableMessage = retryableSessionUnavailableMessage(forConnectError: error) {
            return retryableSessionUnavailableMessage
        }
        if relayCloseCodeRawValue(fromConnectError: error) == 4003 {
            return "A newer agnt connection replaced this socket. Tap Reconnect to try again."
        }
        if isOversizedRelayPayloadError(error) {
            return oversizedRelayPayloadMessage
        }
        if shouldTreatSendFailureAsDisconnect(error) || isBenignBackgroundDisconnect(error) {
            return "Connection was interrupted. Tap Reconnect to try again."
        }
        if isRecoverableTransientConnectionError(error) {
            return "Connection timed out. Check server/network."
        }
        return error.localizedDescription
    }

    // Distinguishes relay frame-size failures from generic disconnects so reconnect UI can explain them.
    func isOversizedRelayPayloadError(_ error: Error) -> Bool {
        if let nwError = error as? NWError,
           case .posix(let code) = nwError,
           code == .EMSGSIZE {
            return true
        }

        let nsError = error as NSError
        return nsError.domain == NSPOSIXErrorDomain
            && nsError.code == Int(POSIXErrorCode.EMSGSIZE.rawValue)
    }

    var oversizedRelayPayloadMessage: String {
        "A thread payload was too large for the relay connection. This can happen while reopening image-heavy chats even if you didn't press Send."
    }

    // Treats `.inactive` app switches like background for user-facing reconnect noise.
    func isActivelyForegroundedForConnectionUI() -> Bool {
        isAppInForeground && applicationStateProvider() == .active
    }

    // Pulls a stable raw close code out of NWProtocolWebSocket so we can classify relay shutdowns.
    func relayCloseCodeRawValue(_ closeCode: NWProtocolWebSocket.CloseCode?) -> UInt16? {
        switch closeCode {
        case .protocolCode(let definedCode):
            return definedCode.rawValue
        case .applicationCode(let rawValue), .privateCode(let rawValue):
            return rawValue
        case nil:
            return nil
        @unknown default:
            return nil
        }
    }

    // Extracts relay close codes from connect-time URLSession delegate errors.
    func relayCloseCodeRawValue(fromConnectError error: Error) -> UInt16? {
        guard let serviceError = error as? CodexServiceError,
              case .invalidInput(let message) = serviceError else {
            return nil
        }

        let prefix = "WebSocket closed during connect ("
        guard let prefixRange = message.range(of: prefix) else {
            return nil
        }

        let suffix = message[prefixRange.upperBound...]
        guard let closingParenIndex = suffix.firstIndex(of: ")") else {
            return nil
        }

        return UInt16(suffix[..<closingParenIndex])
    }

    // Distinguishes "temporary socket blip" from "that QR pairing is no longer valid".
    func permanentRelayDisconnectMessage(for closeCode: NWProtocolWebSocket.CloseCode?) -> String? {
        guard let rawValue = relayCloseCodeRawValue(closeCode),
              Self.permanentRelayCloseCodeRawValues.contains(rawValue) else {
            return nil
        }

        switch rawValue {
        case 4001:
            return "This relay session was replaced by another computer connection. Scan a new QR code to reconnect."
        default:
            return "This relay pairing is no longer valid. Scan a new QR code to reconnect."
        }
    }

    func isRetryableRelayClose(_ closeCode: NWProtocolWebSocket.CloseCode?) -> Bool {
        guard let rawValue = relayCloseCodeRawValue(closeCode) else {
            return false
        }

        return Self.retryableRelayCloseCodeRawValues.contains(rawValue)
    }

    // Treats `4002` as ambiguous while the Mac bridge may still be recreating the same relay session.
    func retryableSessionUnavailableMessage(for closeCode: NWProtocolWebSocket.CloseCode?) -> String? {
        guard relayCloseCodeRawValue(closeCode) == 4002 else {
            return nil
        }

        return "Trying to reach your saved computer. agnt will keep retrying. If you restarted the bridge on that computer, scan the new QR code."
    }

    func retryableSessionUnavailableMessage(forConnectError error: Error) -> String? {
        guard relayCloseCodeRawValue(fromConnectError: error) == 4002 else {
            return nil
        }

        return "Trying to reach your saved computer. agnt will keep retrying. If you restarted the bridge on that computer, scan the new QR code."
    }

    // Surfaces relay-enforced drops that keep the pairing valid but lost the current send.
    func explicitRelayDropMessage(for closeCode: NWProtocolWebSocket.CloseCode?) -> String? {
        guard let rawValue = relayCloseCodeRawValue(closeCode),
              Self.explicitRelayDropCloseCodeRawValues.contains(rawValue) else {
            return nil
        }

        return "The paired computer was temporarily unavailable and this message could not be delivered. Wait a moment, then try again."
    }

    func shouldClearSavedRelaySession(for closeCode: NWProtocolWebSocket.CloseCode?) -> Bool {
        guard let rawValue = relayCloseCodeRawValue(closeCode) else {
            return false
        }

        return Self.permanentRelayCloseCodeRawValues.contains(rawValue)
    }
}
