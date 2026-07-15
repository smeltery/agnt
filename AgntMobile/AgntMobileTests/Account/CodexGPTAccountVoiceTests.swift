// FILE: CodexGPTAccountVoiceTests.swift
// Purpose: Verifies voice transcription auth and recovery behavior.
// Layer: Unit Test
// Exports: CodexGPTAccountVoiceTests
// Depends on: XCTest, AgntMobile

import Foundation
import XCTest
@testable import AgntMobile

@MainActor
final class CodexGPTAccountVoiceTests: CodexGPTAccountTestCase {
    func testVoiceTranscriptionPreflightRejectsOversizedClips() {
        let preflight = CodexVoiceTranscriptionPreflight(
            byteCount: CodexVoiceTranscriptionPreflight.maxByteCount + 1,
            durationSeconds: 30
        )

        XCTAssertThrowsError(try preflight.validate()) { error in
            XCTAssertEqual(error.localizedDescription, "Voice clips must be smaller than 10 MB.")
        }
    }

    func testVoiceTranscriptionPreflightRejectsClipsLongerThan150Seconds() {
        let preflight = CodexVoiceTranscriptionPreflight(
            byteCount: 2_048,
            durationSeconds: 150.5
        )

        XCTAssertThrowsError(try preflight.validate()) { error in
            XCTAssertEqual(error.localizedDescription, "Voice clips must be 150 seconds or less.")
        }
    }

    func testVoiceTranscriptionReportsDisconnectedInsteadOfLoginWhenBridgeIsOffline() async {
        let service = makeService()
        service.isConnected = false
        service.gptAccountSnapshot = CodexGPTAccountSnapshot(
            status: .authenticated,
            authMethod: .chatgpt,
            email: "voice@example.com",
            displayName: nil,
            planType: "plus",
            loginInFlight: false,
            needsReauth: false,
            expiresAt: nil,
            tokenReady: true,
            updatedAt: .now
        )

        await XCTAssertThrowsErrorAsync({
            try await service.transcribeVoiceAudioFile(
                at: URL(fileURLWithPath: "/tmp/agnt-voice-test.wav"),
                durationSeconds: 1
            )
        }) { error in
            XCTAssertEqual(error.localizedDescription, "Connect to your Mac before using voice transcription.")
        }
    }

    func testVoiceTranscriptionUsesBridgeResolvedTokenForDirectUpload() async throws {
        let service = makeService()
        service.isConnected = true
        let clipURL = try makeTemporaryVoiceClipURL()
        defer { try? FileManager.default.removeItem(at: clipURL) }
        let expectedAudio = makeTestWavData()
        let expectedToken = "chatgpt-token-123"

        var observedMethod: String?
        var observedParams: JSONValue?
        service.requestTransportOverride = { method, params in
            observedMethod = method
            observedParams = params
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "token": .string(expectedToken),
                ]),
                includeJSONRPC: false
            )
        }
        GPTVoiceTranscriptionManager.transcribeOverride = { wavData, token in
            XCTAssertEqual(wavData, expectedAudio)
            XCTAssertEqual(token, expectedToken)
            return "transcribed on phone"
        }
        defer { GPTVoiceTranscriptionManager.transcribeOverride = nil }

        let transcript = try await service.transcribeVoiceAudioFile(at: clipURL, durationSeconds: 1.25)

        XCTAssertEqual(transcript, "transcribed on phone")
        XCTAssertEqual(observedMethod, "voice/resolveAuth")
        XCTAssertNil(observedParams)
    }

    func testUnsupportedVoiceBridgeAuthMarksBridgeSessionAsUnsupported() {
        let service = makeService()
        let error = CodexServiceError.rpcError(
            RPCError(
                code: -32600,
                message: "Invalid request: unknown variant `voice/resolveAuth`, expected one of `initialize`, `thread/start`"
            )
        )

        XCTAssertTrue(service.consumeUnsupportedVoiceBridgeAuth(error))
        XCTAssertFalse(service.supportsBridgeVoiceAuth)
        XCTAssertEqual(service.classifyVoiceFailure(error), .bridgeSessionUnsupported)
    }

    func testResolvedVoiceRecoveryClearsBannerOnceVoiceAuthIsHealthy() {
        let service = makeService()
        service.gptAccountSnapshot = CodexGPTAccountSnapshot(
            status: .authenticated,
            authMethod: .chatgpt,
            email: "voice@example.com",
            displayName: nil,
            planType: "plus",
            loginInFlight: false,
            needsReauth: false,
            expiresAt: nil,
            tokenReady: true,
            updatedAt: .now
        )

        XCTAssertNil(service.resolveVoiceRecoveryReason(.voiceSyncInProgress))
        XCTAssertNil(service.resolveVoiceRecoveryReason(.macLoginRequired))
        XCTAssertNil(service.resolveVoiceRecoveryReason(.macReauthenticationRequired))
    }

    func testVoiceMissingTokenWhileAuthenticatedIsClassifiedAsSyncing() {
        let service = makeService()
        service.gptAccountSnapshot = CodexGPTAccountSnapshot(
            status: .authenticated,
            authMethod: .chatgpt,
            email: "voice@example.com",
            displayName: nil,
            planType: "plus",
            loginInFlight: false,
            needsReauth: false,
            expiresAt: nil,
            tokenReady: false,
            tokenUnavailableSince: .now,
            updatedAt: .now
        )

        let error = CodexServiceError.rpcError(
            RPCError(
                code: -32000,
                message: "No ChatGPT session token available. Sign in to ChatGPT on the Mac.",
                data: .object([
                    "errorCode": .string("token_missing"),
                ])
            )
        )

        XCTAssertEqual(service.classifyVoiceFailure(error), .voiceSyncInProgress)
    }

    func testVoiceAuthUnavailableIsClassifiedAsReconnectRequired() {
        let service = makeService()
        let error = CodexServiceError.rpcError(
            RPCError(
                code: -32000,
                message: "Could not read ChatGPT session from the Mac runtime. Is the bridge running?",
                data: .object([
                    "errorCode": .string("auth_unavailable"),
                ])
            )
        )

        XCTAssertEqual(service.classifyVoiceFailure(error), .reconnectRequired)
    }

    func testSuccessfulLoginKeepsPollingUntilVoiceTokenIsReady() async throws {
        let service = makeService()
        service.isConnected = true
        var accountStatusReadCount = 0

        service.requestTransportOverride = { method, params in
            switch method {
            case "account/login/start":
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "type": .string("chatgpt"),
                        "loginId": .string("login-123"),
                        "authUrl": .string("https://example.com/login"),
                    ]),
                    includeJSONRPC: false
                )
            case "account/status/read":
                XCTAssertNil(params)
                accountStatusReadCount += 1
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "status": .string("authenticated"),
                        "authMethod": .string("chatgpt"),
                        "email": .string("voice@example.com"),
                        "planType": .string("pro"),
                        "loginInFlight": .bool(false),
                        "needsReauth": .bool(false),
                        "tokenReady": .bool(accountStatusReadCount >= 2),
                    ]),
                    includeJSONRPC: false
                )
            default:
                XCTFail("Unexpected method \(method)")
                throw CodexServiceError.disconnected
            }
        }

        _ = try await service.startOrResumeGPTLogin()
        service.handleIncomingRPCMessage(
            RPCMessage(
                method: "account/login/completed",
                params: .object([
                    "loginId": .string("login-123"),
                    "success": .bool(true),
                    "error": .null,
                ])
            )
        )

        await yieldMainActor(times: 3)

        XCTAssertEqual(service.gptAccountSnapshot.status, .authenticated)
        XCTAssertEqual(service.gptAccountSnapshot.tokenReady, false)
        XCTAssertFalse(service.gptAccountSnapshot.needsReauth)
        XCTAssertNotNil(service.currentPendingGPTLogin())

        await service.refreshGPTAccountState()

        XCTAssertEqual(service.gptAccountSnapshot.status, .authenticated)
        XCTAssertEqual(service.gptAccountSnapshot.tokenReady, true)
        XCTAssertFalse(service.gptAccountSnapshot.needsReauth)
        XCTAssertNil(service.currentPendingGPTLogin())
    }
}
