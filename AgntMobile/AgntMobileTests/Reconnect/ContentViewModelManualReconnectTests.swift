// FILE: ContentViewModelManualReconnectTests.swift
// Purpose: Verifies manual reconnect retry, cancellation, and scanner takeover behavior.
// Layer: Unit Test
// Exports: ContentViewModelManualReconnectTests
// Depends on: XCTest, Foundation, Network, AgntMobile

import Foundation
import Network
import XCTest
@testable import AgntMobile

@MainActor
final class ContentViewModelManualReconnectTests: ContentViewModelReconnectTestCase {
    func testForegroundReconnectStopsAfterRetryLimitWithRetryableFailures() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        var attempts = 0

        service.relaySessionId = "saved-session"
        service.relayUrl = "wss://relay.local/relay"
        service.shouldAutoReconnectOnForeground = true
        viewModel.reconnectAttemptLimitOverride = 2
        viewModel.reconnectSleepOverride = { _ in }
        viewModel.connectOverride = { _, _ in
            attempts += 1
            throw NWError.posix(.ECONNABORTED)
        }

        await viewModel.attemptAutoReconnectOnForegroundIfNeeded(codex: service)

        XCTAssertEqual(attempts, 2)
        XCTAssertFalse(service.shouldAutoReconnectOnForeground)
        XCTAssertEqual(service.lastErrorMessage, "Could not reconnect. Tap Reconnect to try again.")
        XCTAssertEqual(service.connectionRecoveryState, .idle)
    }

    func testManualReconnectReResolvesReconnectURLBetweenRetryAttempts() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        let macDeviceID = "mac-\(UUID().uuidString)"
        let relayURL = "wss://relay.local/relay"
        var resolveAttempts = 0
        var attemptedURLs: [String] = []

        service.trustedMacRegistry.records[macDeviceID] = CodexTrustedMacRecord(
            macDeviceId: macDeviceID,
            macIdentityPublicKey: Data(repeating: 14, count: 32).base64EncodedString(),
            lastPairedAt: Date(),
            relayURL: relayURL
        )
        service.lastTrustedMacDeviceId = macDeviceID
        service.setCurrentTrustedMacDeviceId(macDeviceID)
        service.relaySessionId = "saved-session"
        service.relayUrl = relayURL
        service.relayMacDeviceId = macDeviceID
        viewModel.reconnectSleepOverride = { _ in }
        service.trustedSessionResolverOverride = {
            resolveAttempts += 1
            if resolveAttempts == 1 {
                throw CodexTrustedSessionResolveError.macOffline("Your trusted Mac is offline right now.")
            }
            return CodexTrustedSessionResolveResponse(
                ok: true,
                macDeviceId: macDeviceID,
                macIdentityPublicKey: Data(repeating: 15, count: 32).base64EncodedString(),
                displayName: "My Mac",
                sessionId: "live-session"
            )
        }
        viewModel.connectOverride = { _, serverURL in
            attemptedURLs.append(serverURL)
            if attemptedURLs.count == 1 {
                throw CodexServiceError.invalidInput("WebSocket closed during connect (4002)")
            }
        }

        await viewModel.toggleConnection(codex: service)

        XCTAssertEqual(resolveAttempts, 2)
        XCTAssertEqual(
            attemptedURLs,
            ["\(relayURL)/saved-session", "\(relayURL)/live-session"]
        )
        XCTAssertFalse(viewModel.isAttemptingManualReconnect)
    }

    func testManualReconnectCancelsStuckTrustedSessionResolve() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        let macDeviceID = "mac-\(UUID().uuidString)"
        let relayURL = "wss://relay.local/relay"
        var resolveAttempts = 0
        var connectAttempts = 0

        service.trustedMacRegistry.records[macDeviceID] = CodexTrustedMacRecord(
            macDeviceId: macDeviceID,
            macIdentityPublicKey: Data(repeating: 11, count: 32).base64EncodedString(),
            lastPairedAt: Date(),
            relayURL: relayURL
        )
        service.lastTrustedMacDeviceId = macDeviceID
        service.setCurrentTrustedMacDeviceId(macDeviceID)
        service.relaySessionId = "saved-session"
        service.relayUrl = relayURL
        service.relayMacDeviceId = macDeviceID
        service.shouldAutoReconnectOnForeground = true
        viewModel.reconnectSleepOverride = { _ in await Task.yield() }
        service.trustedSessionResolverOverride = {
            resolveAttempts += 1
            if resolveAttempts == 1 {
                while !Task.isCancelled {
                    await Task.yield()
                }
                throw CancellationError()
            }
            return CodexTrustedSessionResolveResponse(
                ok: true,
                macDeviceId: macDeviceID,
                macIdentityPublicKey: Data(repeating: 12, count: 32).base64EncodedString(),
                displayName: "My Mac",
                sessionId: "live-session"
            )
        }
        viewModel.connectOverride = { _, serverURL in
            connectAttempts += 1
            XCTAssertEqual(serverURL, "\(relayURL)/live-session")
        }

        let autoReconnectTask = Task {
            await viewModel.attemptAutoReconnectOnForegroundIfNeeded(codex: service)
        }

        while !viewModel.isAttemptingAutoReconnect || resolveAttempts == 0 {
            await Task.yield()
        }

        await viewModel.toggleConnection(codex: service)
        await autoReconnectTask.value

        XCTAssertEqual(resolveAttempts, 2)
        XCTAssertEqual(connectAttempts, 1)
        XCTAssertFalse(viewModel.isAttemptingAutoReconnect)
        XCTAssertFalse(service.shouldAutoReconnectOnForeground)
    }

    func testTrustedResolveCancelsWhenCallerTaskIsCancelled() async {
        let service = makeService()
        var resolverSawCancellation = false

        service.trustedSessionResolverOverride = {
            while !Task.isCancelled {
                await Task.yield()
            }
            resolverSawCancellation = true
            throw CancellationError()
        }

        let callerTask = Task {
            try await service.resolveTrustedMacSession()
        }

        while service.trustedSessionResolveTask == nil {
            await Task.yield()
        }

        callerTask.cancel()

        do {
            _ = try await callerTask.value
            XCTFail("Expected caller cancellation to abort the trusted resolve task.")
        } catch is CancellationError {
            // Expected.
        } catch {
            XCTFail("Expected CancellationError, got \(error)")
        }

        while service.trustedSessionResolveTask != nil || !resolverSawCancellation {
            await Task.yield()
        }

        XCTAssertTrue(resolverSawCancellation)
        XCTAssertNil(service.trustedSessionResolveTask)
        XCTAssertNil(service.trustedSessionResolveTaskID)
    }

    func testManualReconnectDoesNotWaitForOldAutoReconnectBackoff() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        var connectAttempts = 0

        service.relaySessionId = "saved-session"
        service.relayUrl = "wss://relay.local/relay"
        service.shouldAutoReconnectOnForeground = true
        viewModel.reconnectSleepChunkNanosecondsOverride = 10_000_000
        viewModel.connectOverride = { codex, _ in
            connectAttempts += 1
            if connectAttempts == 1 {
                throw CodexServiceError.disconnected
            }
        }

        let autoReconnectTask = Task {
            await viewModel.attemptAutoReconnectOnForegroundIfNeeded(codex: service)
        }

        while true {
            if case .retrying(let attempt, _) = service.connectionRecoveryState,
               attempt == 1 {
                break
            }
            await Task.yield()
        }

        let reconnectStartedAt = Date()
        await viewModel.toggleConnection(codex: service)
        let reconnectElapsed = Date().timeIntervalSince(reconnectStartedAt)
        await autoReconnectTask.value

        XCTAssertEqual(connectAttempts, 2)
        XCTAssertFalse(service.shouldAutoReconnectOnForeground)
        XCTAssertLessThan(reconnectElapsed, 0.75)
    }

    func testManualReconnectIgnoresRapidSecondTapWhileFirstAttemptIsInFlight() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        var connectAttempts = 0
        var allowFirstAttemptToFinish = false

        service.relaySessionId = "saved-session"
        service.relayUrl = "wss://relay.local/relay"
        viewModel.connectOverride = { _, _ in
            connectAttempts += 1
            while !allowFirstAttemptToFinish {
                await Task.yield()
            }
        }

        let firstTapTask = Task {
            await viewModel.toggleConnection(codex: service)
        }

        while !viewModel.isAttemptingManualReconnect {
            await Task.yield()
        }

        let secondTapTask = Task {
            await viewModel.toggleConnection(codex: service)
        }

        await Task.yield()
        allowFirstAttemptToFinish = true

        await firstTapTask.value
        await secondTapTask.value

        XCTAssertEqual(connectAttempts, 1)
        XCTAssertFalse(viewModel.isAttemptingManualReconnect)
    }

    func testManualScannerCancelsManualReconnectBackoff() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        var connectAttempts = 0

        service.relaySessionId = "saved-session"
        service.relayUrl = "wss://relay.local/relay"
        viewModel.reconnectSleepChunkNanosecondsOverride = 10_000_000
        viewModel.connectOverride = { _, _ in
            connectAttempts += 1
            throw CodexServiceError.disconnected
        }

        let reconnectTask = Task {
            await viewModel.toggleConnection(codex: service)
        }

        while true {
            if case .retrying(let attempt, _) = service.connectionRecoveryState,
               attempt == 1 {
                break
            }
            await Task.yield()
        }

        let scannerTakeoverStartedAt = Date()
        await viewModel.stopAutoReconnectForManualScan(codex: service)
        let scannerTakeoverElapsed = Date().timeIntervalSince(scannerTakeoverStartedAt)
        await reconnectTask.value

        XCTAssertEqual(connectAttempts, 1)
        XCTAssertFalse(viewModel.isAttemptingManualReconnect)
        XCTAssertLessThan(scannerTakeoverElapsed, 0.75)
    }

    func testManualScannerCancellationDoesNotLeaveTrustedResolveError() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        let macDeviceID = "mac-\(UUID().uuidString)"
        let relayURL = "wss://relay.local/relay"
        var resolveAttempts = 0

        service.trustedMacRegistry.records[macDeviceID] = CodexTrustedMacRecord(
            macDeviceId: macDeviceID,
            macIdentityPublicKey: Data(repeating: 13, count: 32).base64EncodedString(),
            lastPairedAt: Date(),
            relayURL: relayURL
        )
        service.lastTrustedMacDeviceId = macDeviceID
        service.setCurrentTrustedMacDeviceId(macDeviceID)
        service.relayUrl = relayURL
        service.relayMacDeviceId = macDeviceID
        service.lastErrorMessage = "old error"
        service.trustedSessionResolverOverride = {
            resolveAttempts += 1
            while !Task.isCancelled {
                await Task.yield()
            }
            throw CancellationError()
        }

        let reconnectTask = Task {
            await viewModel.toggleConnection(codex: service)
        }

        while !viewModel.isAttemptingManualReconnect || resolveAttempts == 0 {
            await Task.yield()
        }

        await viewModel.stopAutoReconnectForManualScan(codex: service)
        await reconnectTask.value

        XCTAssertEqual(resolveAttempts, 1)
        XCTAssertNil(service.lastErrorMessage)
        XCTAssertFalse(viewModel.isAttemptingManualReconnect)
    }
}
