// FILE: CodexGPTAccountTests.swift
// Purpose: Verifies bridge-owned ChatGPT account and bridge-version state.
// Layer: Unit Test
// Exports: CodexGPTAccountTests
// Depends on: XCTest, AgntMobile

import Foundation
import XCTest
@testable import AgntMobile

@MainActor
final class CodexGPTAccountTests: CodexGPTAccountTestCase {
    func testKnownWindowsBridgeDoesNotUseLegacyMacDisplayWakeFallback() {
        let service = makeService()
        let macDeviceID = "host-\(UUID().uuidString)"

        service.lastTrustedMacDeviceId = macDeviceID
        service.trustedMacRegistry.records[macDeviceID] = CodexTrustedMacRecord(
            macDeviceId: macDeviceID,
            macIdentityPublicKey: Data(repeating: 7, count: 32).base64EncodedString(),
            lastPairedAt: Date()
        )
        service.gptAccountSnapshot.hostPlatform = .windows
        service.gptAccountSnapshot.hostCapabilities = nil

        XCTAssertEqual(service.bridgeHostPlatform, .windows)
        XCTAssertFalse(service.supportsDisplayWake)
        XCTAssertFalse(service.supportsDesktopAppHandoff)
        XCTAssertFalse(service.supportsKeepAwakeWhileBridgeRuns)
    }

    func testKnownMacBridgeKeepsLegacyDisplayWakeFallback() {
        let service = makeService()
        let macDeviceID = "mac-\(UUID().uuidString)"

        service.lastTrustedMacDeviceId = macDeviceID
        service.trustedMacRegistry.records[macDeviceID] = CodexTrustedMacRecord(
            macDeviceId: macDeviceID,
            macIdentityPublicKey: Data(repeating: 8, count: 32).base64EncodedString(),
            lastPairedAt: Date()
        )
        service.gptAccountSnapshot.hostPlatform = .macOS
        service.gptAccountSnapshot.hostCapabilities = nil

        XCTAssertTrue(service.supportsDisplayWake)
        XCTAssertTrue(service.supportsDesktopAppHandoff)
        XCTAssertTrue(service.supportsKeepAwakeWhileBridgeRuns)
    }

    func testRefreshGPTAccountStateDecodesSanitizedBridgeStatus() async {
        let service = makeService()
        service.isConnected = true

        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "account/status/read")
            XCTAssertNil(params)
            return RPCMessage(
                id: .string(UUID().uuidString),
                    result: .object([
                        "status": .string("authenticated"),
                        "authMethod": .string("chatgpt"),
                        "email": .string("user@example.com"),
                        "planType": .string("plus"),
                        "loginInFlight": .bool(false),
                        "needsReauth": .bool(false),
                        "tokenReady": .bool(true),
                    ]),
                    includeJSONRPC: false
                )
            }

        await service.refreshGPTAccountState()

        XCTAssertEqual(service.gptAccountSnapshot.status, .authenticated)
        XCTAssertEqual(service.gptAccountSnapshot.authMethod, .chatgpt)
        XCTAssertEqual(service.gptAccountSnapshot.email, "user@example.com")
        XCTAssertEqual(service.gptAccountSnapshot.planType, "plus")
        XCTAssertFalse(service.gptAccountSnapshot.loginInFlight)
        XCTAssertTrue(service.gptAccountSnapshot.isVoiceTokenReady)
        XCTAssertNil(service.gptAccountErrorMessage)
    }

    func testRefreshGPTAccountStateFallsBackToLegacyGetAuthStatusPayload() async {
        let service = makeService()
        service.isConnected = true
        var observedMethods: [String] = []

        service.requestTransportOverride = { method, params in
            observedMethods.append(method)

            switch method {
            case "account/status/read":
                XCTAssertNil(params)
                throw CodexServiceError.invalidInput("method not found")
            case "getAuthStatus":
                XCTAssertNil(params)
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "authMethod": .string("chatgptAuthTokens"),
                        "authToken": .string("legacy-token"),
                        "requiresOpenaiAuth": .bool(false),
                    ]),
                    includeJSONRPC: false
                )
            default:
                XCTFail("Unexpected method \(method)")
                throw CodexServiceError.disconnected
            }
        }

        await service.refreshGPTAccountState()

        XCTAssertEqual(observedMethods, ["account/status/read", "getAuthStatus"])
        XCTAssertEqual(service.gptAccountSnapshot.status, .authenticated)
        XCTAssertEqual(service.gptAccountSnapshot.authMethod, .chatgpt)
        XCTAssertTrue(service.gptAccountSnapshot.isVoiceTokenReady)
        XCTAssertFalse(service.gptVoiceRequiresLogin)
    }

    func testRefreshBridgeVersionStatePresentsOptionalBridgeUpdateWhenLatestIsNewer() async {
        let service = makeService()
        service.isConnected = true

        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "account/status/read")
            XCTAssertNil(params)
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "status": .string("authenticated"),
                    "authMethod": .string("chatgpt"),
                    "loginInFlight": .bool(false),
                    "needsReauth": .bool(false),
                    "tokenReady": .bool(true),
                    "bridgeVersion": .string("1.3.9"),
                    "bridgeLatestVersion": .string("1.4.0"),
                ]),
                includeJSONRPC: false
            )
        }

        await service.refreshBridgeVersionState(allowAvailableBridgeUpdatePrompt: true)

        XCTAssertEqual(service.bridgeInstalledVersion, "1.3.9")
        XCTAssertEqual(service.latestBridgePackageVersion, "1.4.0")
        XCTAssertEqual(
            service.bridgeUpdatePrompt?.title,
            "A newer agnt update is available on your Mac"
        )
        XCTAssertEqual(service.bridgeUpdatePrompt?.command, "npm install -g @dotbrains/agnt@latest")
        XCTAssertEqual(service.gptAccountSnapshot.status, .unknown)
    }

    func testRefreshBridgeVersionStateDoesNotPresentOptionalBridgeUpdateWithoutForegroundFlag() async {
        let service = makeService()
        service.isConnected = true

        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "account/status/read")
            XCTAssertNil(params)
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "status": .string("authenticated"),
                    "authMethod": .string("chatgpt"),
                    "loginInFlight": .bool(false),
                    "needsReauth": .bool(false),
                    "tokenReady": .bool(true),
                    "bridgeVersion": .string("1.3.9"),
                    "bridgeLatestVersion": .string("1.4.0"),
                ]),
                includeJSONRPC: false
            )
        }

        await service.refreshBridgeVersionState()

        XCTAssertNil(service.bridgeUpdatePrompt)
    }

    func testRefreshBridgeVersionStateDoesNotRepeatOptionalBridgeUpdateForSameLatestVersion() async {
        let service = makeService()
        service.isConnected = true

        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "account/status/read")
            XCTAssertNil(params)
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "status": .string("authenticated"),
                    "authMethod": .string("chatgpt"),
                    "loginInFlight": .bool(false),
                    "needsReauth": .bool(false),
                    "tokenReady": .bool(true),
                    "bridgeVersion": .string("1.3.9"),
                    "bridgeLatestVersion": .string("1.4.0"),
                ]),
                includeJSONRPC: false
            )
        }

        await service.refreshBridgeVersionState(allowAvailableBridgeUpdatePrompt: true)
        let firstPrompt = service.bridgeUpdatePrompt

        service.bridgeUpdatePrompt = nil
        await service.refreshBridgeVersionState(allowAvailableBridgeUpdatePrompt: true)

        XCTAssertNotNil(firstPrompt)
        XCTAssertNil(service.bridgeUpdatePrompt)
    }

    func testForegroundReturnRefreshesBridgeVersionAndPresentsOptionalUpdatePrompt() async {
        let service = makeService()
        service.isConnected = true
        service.isInitialized = true
        service.syncRealtimeEnabled = false
        service.isAppInForeground = false

        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "account/status/read")
            XCTAssertNil(params)
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "status": .string("authenticated"),
                    "authMethod": .string("chatgpt"),
                    "loginInFlight": .bool(false),
                    "needsReauth": .bool(false),
                    "tokenReady": .bool(true),
                    "bridgeVersion": .string("1.3.9"),
                    "bridgeLatestVersion": .string("1.4.0"),
                ]),
                includeJSONRPC: false
            )
        }

        service.setForegroundState(true)
        await yieldMainActor(times: 3)

        XCTAssertEqual(service.bridgeInstalledVersion, "1.3.9")
        XCTAssertEqual(service.latestBridgePackageVersion, "1.4.0")
        XCTAssertEqual(
            service.bridgeUpdatePrompt?.title,
            "A newer agnt update is available on your Mac"
        )
    }
}
