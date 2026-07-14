// FILE: CodexService+TransportKeepAlive.swift
// Purpose: Maintains websocket liveness and foreground probes.
// Layer: Service
// Exports: CodexService transport keepalive helpers
// Depends on: Foundation, Network

import Foundation
import Network

private enum CodexWebSocketKeepAlivePolicy {
    static let intervalNanoseconds: UInt64 = 25_000_000_000
    static let foregroundProbeTimeoutNanoseconds: UInt64 = 1_500_000_000
}

private final class CodexForegroundProbeWaiter: @unchecked Sendable {
    private let lock = NSLock()
    private let continuation: CheckedContinuation<Result<Void, Error>, Never>
    private var didFinish = false
    private var tasks: [Task<Void, Never>] = []

    init(continuation: CheckedContinuation<Result<Void, Error>, Never>) {
        self.continuation = continuation
    }

    func addTask(_ task: Task<Void, Never>) {
        lock.lock()
        let shouldCancel = didFinish
        if !didFinish {
            tasks.append(task)
        }
        lock.unlock()

        if shouldCancel {
            task.cancel()
        }
    }

    func finish(_ result: Result<Void, Error>) {
        lock.lock()
        guard !didFinish else {
            lock.unlock()
            return
        }
        didFinish = true
        let tasksToCancel = tasks
        tasks.removeAll()
        lock.unlock()

        for task in tasksToCancel {
            task.cancel()
        }
        continuation.resume(returning: result)
    }
}

extension CodexService {
    func startWebSocketKeepAliveLoop() {
        guard isConnected, isInitialized, isAppInForeground else {
            stopWebSocketKeepAliveLoop()
            return
        }
        guard webSocketKeepAliveTask == nil else {
            return
        }
        guard webSocketKeepAlivePingOverride != nil || webSocketConnection != nil || webSocketTask != nil else {
            return
        }

        webSocketKeepAliveTask = Task { @MainActor [weak self] in
            while let self, !Task.isCancelled {
                let interval = self.webSocketKeepAliveIntervalOverrideNanoseconds
                    ?? CodexWebSocketKeepAlivePolicy.intervalNanoseconds
                try? await Task.sleep(nanoseconds: interval)
                guard !Task.isCancelled else {
                    return
                }
                guard self.isConnected, self.isInitialized, self.isAppInForeground else {
                    self.stopWebSocketKeepAliveLoop()
                    return
                }

                do {
                    try await self.sendWebSocketKeepAlivePing()
                } catch {
                    guard !Task.isCancelled else {
                        return
                    }
                    self.handleReceiveError(error)
                    return
                }
            }
        }
    }

    func stopWebSocketKeepAliveLoop() {
        webSocketKeepAliveTask?.cancel()
        webSocketKeepAliveTask = nil
    }

    // Probes a foregrounded socket immediately so overnight zombie connections do not wait for the next 25s keepalive.
    func probeForegroundConnectionIfNeeded() async {
        guard isConnected, isInitialized, isAppInForeground else {
            return
        }

        let result = await foregroundConnectionProbeResult(
            timeoutNanoseconds: webSocketForegroundProbeTimeoutOverrideNanoseconds
                ?? CodexWebSocketKeepAlivePolicy.foregroundProbeTimeoutNanoseconds
        )

        if case .failure(let error) = result,
           isAppInForeground,
           isConnected || isInitialized {
            handleReceiveError(error)
        }
    }

    private func foregroundConnectionProbeResult(timeoutNanoseconds: UInt64) async -> Result<Void, Error> {
        await withCheckedContinuation { continuation in
            let waiter = CodexForegroundProbeWaiter(continuation: continuation)

            let pingTask = Task { @MainActor [weak self] in
                guard let self else {
                    waiter.finish(.success(()))
                    return
                }

                do {
                    try await self.sendWebSocketKeepAlivePing()
                    waiter.finish(.success(()))
                } catch {
                    waiter.finish(.failure(error))
                }
            }
            waiter.addTask(pingTask)

            let timeoutTask = Task {
                try? await Task.sleep(nanoseconds: timeoutNanoseconds)
                guard !Task.isCancelled else {
                    return
                }
                waiter.finish(.failure(NWError.posix(.ETIMEDOUT)))
            }
            waiter.addTask(timeoutTask)
        }
    }

    func sendWebSocketKeepAlivePing() async throws {
        if let webSocketKeepAlivePingOverride {
            try await webSocketKeepAlivePingOverride()
            return
        }

        if usesManualWebSocketTransport {
            guard let connection = webSocketConnection else {
                throw CodexServiceError.disconnected
            }
            try await sendManualWebSocketFrame(opcode: 0x9, payload: Data(), on: connection)
            return
        }

        if let task = webSocketTask {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                task.sendPing { error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(returning: ())
                    }
                }
            }
            return
        }

        guard let connection = webSocketConnection else {
            throw CodexServiceError.disconnected
        }

        let metadata = NWProtocolWebSocket.Metadata(opcode: .ping)
        let context = NWConnection.ContentContext(identifier: "codex-keepalive-ping", metadata: [metadata])
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(
                content: Data(),
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

}
