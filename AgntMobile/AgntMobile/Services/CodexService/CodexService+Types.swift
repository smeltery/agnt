// FILE: CodexService+Types.swift
// Purpose: Shared support models used by CodexService state, transport, and timeline projection.
// Layer: Service
// Exports: CodexService support types
// Depends on: Foundation, Network, Observation

import Foundation
import Network
import Observation

struct CodexApprovalRequest: Identifiable, Sendable {
    let id: String
    let requestID: JSONValue
    let method: String
    let command: String?
    let reason: String?
    let threadId: String?
    let turnId: String?
    let params: JSONValue?
}

struct CodexRecentActivityLine {
    let line: String
    let timestamp: Date
}

struct CodexRunningThreadWatch: Equatable, Sendable {
    let threadId: String
    let expiresAt: Date
}

struct CodexThreadResumeRequestSignature: Equatable, Sendable {
    let projectPath: String?
    let modelIdentifier: String?
}

struct CodexThreadHistoryPaginationState: Codable, Equatable, Sendable {
    var olderCursor: JSONValue?
    var exhaustedOlderCursor: JSONValue?
    var hasAuthoritativeLocalHistoryStart: Bool
}

struct CodexSubagentIdentityEntry: Equatable, Sendable {
    var threadId: String?
    var agentId: String?
    var nickname: String?
    var role: String?

    var hasMetadata: Bool {
        threadId != nil || agentId != nil || nickname != nil || role != nil
    }
}

struct CodexSecureControlWaiter {
    let id: UUID
    let continuation: CheckedContinuation<String, Error>
}

enum CodexWebSocketTransport {
    case network(NWConnection)
    case manualTCP(NWConnection)
    case urlSession(URLSession, URLSessionWebSocketTask)
}

final class CodexURLSessionWebSocketDelegate: NSObject, URLSessionWebSocketDelegate, URLSessionTaskDelegate {
    private let lock = NSLock()
    private var openContinuation: CheckedContinuation<Void, Error>?
    private var openResult: Result<Void, Error>?

    // Waits for URLSession to confirm the websocket handshake before connect() continues.
    func waitForOpen() async throws {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            defer { lock.unlock() }
            if let openResult {
                continuation.resume(with: openResult)
                return
            }
            openContinuation = continuation
        }
    }

    // Resolves the initial websocket open exactly once from any delegate callback.
    func resolveOpen(with result: Result<Void, Error>) {
        lock.lock()
        guard openResult == nil else {
            lock.unlock()
            return
        }
        openResult = result
        let continuation = openContinuation
        openContinuation = nil
        lock.unlock()
        continuation?.resume(with: result)
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        resolveOpen(with: .success(()))
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        if closeCode == .invalid {
            resolveOpen(with: .failure(CodexServiceError.disconnected))
            return
        }

        resolveOpen(
            with: .failure(
                CodexServiceError.invalidInput("WebSocket closed during connect (\(closeCode.rawValue))")
            )
        )
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        if let error {
            resolveOpen(with: .failure(error))
        }
    }
}

struct CodexBridgeUpdatePrompt: Identifiable, Equatable, Sendable {
    let id = UUID()
    let title: String
    let message: String
    let command: String?

    init(
        title: String,
        message: String,
        command: String?
    ) {
        self.title = title
        self.message = message
        self.command = command
    }
}

struct CodexThreadRuntimeOverride: Codable, Equatable, Sendable {
    var reasoningEffort: String?
    var serviceTierRawValue: String?
    var overridesReasoning: Bool
    var overridesServiceTier: Bool

    var serviceTier: CodexServiceTier? {
        guard let serviceTierRawValue else {
            return nil
        }
        return CodexServiceTier(rawValue: serviceTierRawValue)
    }

    var isEmpty: Bool {
        !overridesReasoning && !overridesServiceTier
    }
}

struct CodexThreadCompletionBanner: Identifiable, Equatable, Sendable {
    let id = UUID()
    let threadId: String
    let title: String
}

struct CodexSystemNotice: Identifiable, Equatable, Sendable {
    let id = UUID()
    let severity: CodexSystemNoticeSeverity
    let title: String?
    let message: String?
    let provider: String?
    let threadId: String?
}

enum CodexSystemNoticeSeverity: Equatable, Sendable {
    case info
    case warn
    case error

    init(rawBridgeValue: String?) {
        switch rawBridgeValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "warn", "warning":
            self = .warn
        case "error", "danger":
            self = .error
        default:
            self = .info
        }
    }

    var defaultDurationNanoseconds: UInt64 {
        switch self {
        case .info:
            return 5_000_000_000
        case .warn:
            return 8_000_000_000
        case .error:
            return 12_000_000_000
        }
    }
}

struct CodexMissingNotificationThreadPrompt: Identifiable, Equatable, Sendable {
    let id = UUID()
    let threadId: String
}

enum CodexThreadRunBadgeState: Hashable, Sendable {
    case waitingOnUser
    case running
    case ready
    case failed
}

enum CodexRunCompletionResult: String, Equatable, Sendable {
    case completed
    case failed
}

enum CodexNotificationPayloadKeys {
    static let source = "source"
    static let threadId = "threadId"
    static let turnId = "turnId"
    static let result = "result"
    static let requestId = "requestId"
}

// Tracks the real terminal outcome of a run, including user interruption.
enum CodexTurnTerminalState: String, Codable, Equatable, Sendable {
    case completed
    case failed
    case stopped
}

enum CodexConnectionRecoveryState: Equatable, Sendable {
    case idle
    case retrying(attempt: Int, message: String)
}

enum CodexConnectionPhase: Equatable, Sendable {
    case offline
    case connecting
    case loadingChats
    case syncing
    case connected
}

enum CodexPendingThreadComposerAction: Equatable, Sendable {
    case codeReview(target: CodexPendingCodeReviewTarget)
}

enum CodexThreadForkTarget: Equatable, Sendable {
    case currentProject
    case projectPath(String)
}

enum CodexPendingCodeReviewTarget: Equatable, Sendable {
    case uncommittedChanges
    case baseBranch
}

struct TurnTimelineRenderSnapshot: Equatable {
    let threadID: String
    let messages: [CodexMessage]
    let messageIndexByID: [String: Int]
    let planMatchingMessages: [CodexMessage]
    let timelineChangeToken: Int
    let activeTurnID: String?
    let isThreadRunning: Bool
    let latestTurnTerminalState: CodexTurnTerminalState?
    let completedTurnIDs: Set<String>
    let stoppedTurnIDs: Set<String>
    let assistantRevertStatesByMessageID: [String: AssistantRevertPresentation]
    let repoRefreshSignal: String?
    let hasOlderHistory: Bool
    let hasRemoteOlderHistory: Bool
    let hasLocallyProjectedOlderHistory: Bool
    let usesPaginatedHistory: Bool
    let isLoadingOlderHistory: Bool
    let initialTurnsLoaded: Bool
    let olderHistoryLoadErrorMessage: String?

    // Defaults let pre-pagination call sites compile while slice D1 wires the real
    // cursor-driven values through. Once those sites pass explicit args the defaults
    // here become inert.
    init(
        threadID: String,
        messages: [CodexMessage],
        messageIndexByID: [String: Int],
        planMatchingMessages: [CodexMessage],
        timelineChangeToken: Int,
        activeTurnID: String?,
        isThreadRunning: Bool,
        latestTurnTerminalState: CodexTurnTerminalState?,
        completedTurnIDs: Set<String>,
        stoppedTurnIDs: Set<String>,
        assistantRevertStatesByMessageID: [String: AssistantRevertPresentation],
        repoRefreshSignal: String?,
        hasOlderHistory: Bool = false,
        hasRemoteOlderHistory: Bool = false,
        hasLocallyProjectedOlderHistory: Bool = false,
        usesPaginatedHistory: Bool = false,
        isLoadingOlderHistory: Bool = false,
        initialTurnsLoaded: Bool = false,
        olderHistoryLoadErrorMessage: String? = nil
    ) {
        self.threadID = threadID
        self.messages = messages
        self.messageIndexByID = messageIndexByID
        self.planMatchingMessages = planMatchingMessages
        self.timelineChangeToken = timelineChangeToken
        self.activeTurnID = activeTurnID
        self.isThreadRunning = isThreadRunning
        self.latestTurnTerminalState = latestTurnTerminalState
        self.completedTurnIDs = completedTurnIDs
        self.stoppedTurnIDs = stoppedTurnIDs
        self.assistantRevertStatesByMessageID = assistantRevertStatesByMessageID
        self.repoRefreshSignal = repoRefreshSignal
        self.hasOlderHistory = hasOlderHistory
        self.hasRemoteOlderHistory = hasRemoteOlderHistory
        self.hasLocallyProjectedOlderHistory = hasLocallyProjectedOlderHistory
        self.usesPaginatedHistory = usesPaginatedHistory
        self.isLoadingOlderHistory = isLoadingOlderHistory
        self.initialTurnsLoaded = initialTurnsLoaded
        self.olderHistoryLoadErrorMessage = olderHistoryLoadErrorMessage
    }

    static func empty(threadID: String) -> TurnTimelineRenderSnapshot {
        TurnTimelineRenderSnapshot(
            threadID: threadID,
            messages: [],
            messageIndexByID: [:],
            planMatchingMessages: [],
            timelineChangeToken: 0,
            activeTurnID: nil,
            isThreadRunning: false,
            latestTurnTerminalState: nil,
            completedTurnIDs: [],
            stoppedTurnIDs: [],
            assistantRevertStatesByMessageID: [:],
            repoRefreshSignal: nil,
            hasOlderHistory: false,
            hasRemoteOlderHistory: false,
            hasLocallyProjectedOlderHistory: false,
            usesPaginatedHistory: false,
            isLoadingOlderHistory: false,
            initialTurnsLoaded: false,
            olderHistoryLoadErrorMessage: nil
        )
    }
}

struct PendingSystemStreamingDeltas {
    let threadId: String
    let turnId: String?
    let itemId: String
    let kind: CodexMessageKind
    var deltas: [String]
}

@MainActor
@Observable
final class ThreadTimelineState {
    let threadID: String
    var messages: [CodexMessage]
    var messageRevision: Int
    var activeTurnID: String?
    var isThreadRunning: Bool
    var latestTurnTerminalState: CodexTurnTerminalState?
    var completedTurnIDs: Set<String>
    var stoppedTurnIDs: Set<String>
    var repoRefreshSignal: String?
    var hasOlderHistory: Bool
    var hasRemoteOlderHistory: Bool
    var hasLocallyProjectedOlderHistory: Bool
    var usesPaginatedHistory: Bool
    var isLoadingOlderHistory: Bool
    var initialTurnsLoaded: Bool
    var olderHistoryLoadErrorMessage: String?
    var renderSnapshot: TurnTimelineRenderSnapshot

    init(threadID: String) {
        self.threadID = threadID
        self.messages = []
        self.messageRevision = 0
        self.activeTurnID = nil
        self.isThreadRunning = false
        self.latestTurnTerminalState = nil
        self.completedTurnIDs = []
        self.stoppedTurnIDs = []
        self.repoRefreshSignal = nil
        self.hasOlderHistory = false
        self.hasRemoteOlderHistory = false
        self.hasLocallyProjectedOlderHistory = false
        self.usesPaginatedHistory = false
        self.isLoadingOlderHistory = false
        self.initialTurnsLoaded = false
        self.olderHistoryLoadErrorMessage = nil
        self.renderSnapshot = TurnTimelineRenderSnapshot.empty(threadID: threadID)
    }
}

struct AssistantRevertStateCacheEntry {
    let messageRevision: Int
    let busyRepoRevision: Int
    let revertStateRevision: Int
    let statesByMessageID: [String: AssistantRevertPresentation]
}
