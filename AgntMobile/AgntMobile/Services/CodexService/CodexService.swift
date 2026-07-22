// FILE: CodexService.swift
// Purpose: Central state container for Codex app-server communication.
// Layer: Service
// Exports: CodexService
// Depends on: Foundation, Network, Observation, UIKit, UserNotifications

import Foundation
import Network
import Observation
import UIKit
import UserNotifications

@MainActor
@Observable
final class CodexService {
    static let minimumSupportedBridgePackageVersion = "1.3.9"

    // --- Public state ---------------------------------------------------------

    var threads: [CodexThread] = [] {
        didSet {
            rebuildThreadLookupCaches()
            refreshPinnedThreadSnapshots()
        }
    }
    var isConnected = false
    var isConnecting = false
    var isInitialized = false
    var isLoadingThreads = false
    // Tracks the non-blocking bootstrap that hydrates chats/models after the socket is ready.
    var isBootstrappingConnectionSync = false
    var currentOutput = ""
    var activeThreadId: String?
    var activeTurnId: String?
    var activeTurnIdByThread: [String: String] = [:]

    var runningThreadIDs: Set<String> = []
    // Protects active runs that are real but have not yielded a stable turnId yet.
    var protectedRunningFallbackThreadIDs: Set<String> = []
    var provisionalIDLessTurnIDByThread: [String: String] = [:]
    var displacedActiveTurnIDsByThread: [String: Set<String>] = [:]
    var supersededTurnIDsByIDLessRunByThread: [String: Set<String>] = [:]
    var readyThreadIDs: Set<String> = []
    var failedThreadIDs: Set<String> = []
    // Threads that started a real run and haven't completed yet; survives sync-poll clearing.
    @ObservationIgnored var threadsPendingCompletionHaptic: Set<String> = []
    // Keeps the latest terminal outcome per thread so UI can react to real run completion.
    var latestTurnTerminalStateByThread: [String: CodexTurnTerminalState] = [:]
    // Preserves terminal outcome per turn so completed/stopped blocks stay distinguishable.
    var terminalStateByTurnID: [String: CodexTurnTerminalState] = [:]
    // Desktop-projected turn ids are scoped to one thread; `ipc-turn-1` can repeat.
    var projectedTerminalStateByThreadID: [String: [String: CodexTurnTerminalState]] = [:]
    // Ordered pending runtime approvals keyed by request id so concurrent prompts do not overwrite each other.
    var pendingApprovals: [CodexApprovalRequest] = []
    var lastRawMessage: String?
    var lastErrorMessage: String?
    var keepMacAwakeWhileBridgeRuns = false
    var enableWebTerminalOnBridge = false
    var runtimeDebugLogEntries: [String] = []
    var connectionRecoveryState: CodexConnectionRecoveryState = .idle
    // Per-thread queued drafts for client-side turn queueing while a run is active.
    var queuedTurnDraftsByThread: [String: [QueuedTurnDraft]] = [:]
    // Per-thread queue pause state (active by default when absent).
    var queuePauseStateByThread: [String: QueuePauseState] = [:]
    // Mirrors the Codex runtime persisted thread goal (`thread/goal/updated|cleared`).
    var goalByThreadID: [String: CodexThreadGoal] = [:]
    // Per-thread unsent composer drafts that survive chat switches and app restarts.
    var composerDraftsByThreadID: [String: TurnComposerLocalDraft] = [:]
    // Guards late async attachment completions so cleared drafts are not resurrected.
    @ObservationIgnored var composerDraftMergeRevisionByThreadID: [String: Int] = [:]
    // Bumps when Mac-scoped draft storage is swapped so stale decodes cannot write into the next namespace.
    @ObservationIgnored var composerDraftMergeEpoch: Int = 0
    // Tracks loading attachment IDs that may still merge after their originating view disappears.
    @ObservationIgnored var composerDraftPendingAttachmentIDsByThreadID: [String: Set<String>] = [:]
    var messagesByThread: [String: [CodexMessage]] = [:]
    // Monotonic per-thread revision so views can react to message mutations without hashing full transcripts.
    var messageRevisionByThread: [String: Int] = [:]
    var syncRealtimeEnabled = true
    var availableModels: [CodexModelOption] = []
    var selectedModelId: String?
    var hasPersistedSelectedModelId = false
    var selectedGitWriterModelId: String?
    var selectedReasoningEffort: String?
    var selectedServiceTier: CodexServiceTier?
    // Per-chat runtime overrides let the composer diverge from app-wide defaults.
    var threadRuntimeOverridesByThreadID: [String: CodexThreadRuntimeOverride] = [:]
    var selectedAccessMode: CodexAccessMode = .onRequest
    // Bridge-owned ChatGPT auth snapshot used by Settings and voice gating.
    var gptAccountSnapshot: CodexGPTAccountSnapshot = codexGPTAccountInitialSnapshot() {
        didSet {
            persistGPTAccountSnapshot(gptAccountSnapshot)
        }
    }
    // Holds the most recent account-specific error without colliding with transport-level failures.
    var gptAccountErrorMessage: String?
    var isLoadingModels = false
    // Coalesces post-connect model refreshes behind thread hydration so composer metadata cannot be skipped.
    @ObservationIgnored var pendingRuntimeOptionRefresh = false
    @ObservationIgnored var runtimeOptionRefreshTask: Task<Void, Never>?
    @ObservationIgnored var runtimeOptionRefreshToken: UUID?
    var modelsErrorMessage: String?
    var notificationAuthorizationStatus: UNAuthorizationStatus = .notDetermined
    var pendingNotificationOpenThreadID: String?
    var supportsStructuredSkillInput = true
    var supportsStructuredMentionInput = true
    // Runtime compatibility flag for `turn/start.collaborationMode` plan turns.
    var supportsTurnCollaborationMode = false
    // Runtime compatibility flag for `thread/start|turn/start.serviceTier` speed controls.
    var supportsServiceTier = true
    // Runtime compatibility flag for the bridge-owned voice transcription flow.
    var supportsBridgeVoiceAuth = true
    // Runtime compatibility flag for native `thread/fork` conversation branching.
    var supportsThreadFork = true
    // Runtime compatibility flag for the Codex `thread/goal/*` API.
    var supportsThreadGoals = true
    // Runtime compatibility flag for `thread/turns/list` and `excludeTurns`.
    var supportsTurnPagination = true
    // Seeds brand-new chats with one-shot composer actions like code review.
    var pendingComposerActionByThreadID: [String: CodexPendingThreadComposerAction] = [:]
    // In-memory identity directory for subagents, keyed by thread id and agent id.
    var subagentIdentityVersion: Int = 0

    // Relay session persistence
    var relaySessionId: String?
    var relayUrl: String?
    var relayMacDeviceId: String?
    var relayMacIdentityPublicKey: String?
    var relayProtocolVersion: Int = codexSecureProtocolVersion
    var lastAppliedBridgeOutboundSeq = 0
    var lastAppliedBridgeReplayEpoch: String?
    @ObservationIgnored var pendingCanonicalHistoryRefreshAfterReplayDiscontinuity = false
    // Mirrors the bridge package version currently running on the Mac, if the bridge reports it.
    var bridgeInstalledVersion: String?
    // Mirrors the latest published bridge package version, when the bridge can resolve it.
    var latestBridgePackageVersion: String?
    // Fresh QR scans must use bootstrap once, even if this Mac was already trusted before.
    var shouldForceQRBootstrapOnNextHandshake = false
    // Stops infinite trusted-reconnect loops by escalating back to QR after repeated handshake failures.
    var trustedReconnectFailureCount = 0
    var secureConnectionState: CodexSecureConnectionState = .notPaired
    var secureMacFingerprint: String?
    // Keeps the bridge-update UX visible even if connection cleanup resets secure transport state.
    var bridgeUpdatePrompt: CodexBridgeUpdatePrompt?
    var hasPresentedServiceTierBridgeUpdatePrompt = false
    var hasPresentedThreadForkBridgeUpdatePrompt = false
    var hasPresentedMinimumBridgePackageUpdatePrompt = false
    // Remembers the latest optional npm update we already surfaced so foreground refreshes stay non-spammy.
    var lastPresentedAvailableBridgePackageVersion: String?
    // Mirrors the sidebar ready-dot with a tappable in-app banner when another chat finishes.
    var threadCompletionBanner: CodexThreadCompletionBanner?
    // Toast queue sourced from bridge-level `system/notice` notifications.
    var systemNotices: [CodexSystemNotice] = []
    // Explains why a push-opened chat could not be restored and offers a recovery path.
    var missingNotificationThreadPrompt: CodexMissingNotificationThreadPrompt?
    // Owns the scarce App Store review prompt budget for successful in-app runs.
    @ObservationIgnored let appReviewPromptCoordinator = AppReviewPromptCoordinator()
    // Interactive SSH terminal state is owned on-device so it can bootstrap a Mac before the bridge runs.
    var terminalSnapshot: AgntTerminalSnapshot = .idle
    var terminalSnapshotsById: [String: AgntTerminalSnapshot] = [:]
    var terminalProfile: AgntTerminalProfile = AgntTerminalProfileStore.load()
    @ObservationIgnored let nativeSSHTerminal = AgntNativeSSHTerminal()
    @ObservationIgnored var nativeSSHTerminalsById: [String: AgntNativeSSHTerminal] = [:]

    // --- Internal wiring ------------------------------------------------------

    var webSocketConnection: NWConnection?
    var webSocketSession: URLSession?
    var webSocketSessionDelegate: CodexURLSessionWebSocketDelegate?
    var webSocketTask: URLSessionWebSocketTask?
    var webSocketKeepAliveTask: Task<Void, Never>?
    @ObservationIgnored var compactRuntimeItemCompletedFlushTask: Task<Void, Never>?
    @ObservationIgnored var compactRuntimeItemCompletedCount = 0
    @ObservationIgnored var compactRuntimeItemCompletedTypes: [String: Int] = [:]
    // Raw frame buffer used when the relay runs over manual TCP websocket framing.
    var manualWebSocketReadBuffer = Data()
    var usesManualWebSocketTransport = false
    let webSocketQueue = DispatchQueue(label: "AgntMobile.WebSocket", qos: .userInitiated)
    var pendingRequests: [String: CheckedContinuation<RPCMessage, Error>] = [:]
    // Test hook: intercepts outbound RPC requests without requiring a live socket.
    @ObservationIgnored var requestTransportOverride: ((String, JSONValue?) async throws -> RPCMessage)?
    // Test hook: stubs trusted-session lookup without performing a real relay HTTP request.
    @ObservationIgnored var trustedSessionResolverOverride: (() async throws -> CodexTrustedSessionResolveResponse)?
    // Test hooks: exercise keepalive lifecycle without waiting 25s or opening a real socket.
    @ObservationIgnored var webSocketKeepAliveIntervalOverrideNanoseconds: UInt64?
    @ObservationIgnored var webSocketForegroundProbeTimeoutOverrideNanoseconds: UInt64?
    @ObservationIgnored var webSocketKeepAlivePingOverride: (() async throws -> Void)?
    // Keeps the trusted-session HTTP lookup cancellable so manual retry can preempt a stuck resolve.
    @ObservationIgnored var trustedSessionResolveTask: Task<CodexTrustedSessionResolveResponse, Error>?
    @ObservationIgnored var trustedSessionResolveTaskID: UUID?
    // Assistant streams keep turn fallback separate from item-specific identity to avoid cross-item overlap.
    @ObservationIgnored var streamingAssistantFallbackMessageByTurnID: [String: String] = [:]
    @ObservationIgnored var streamingAssistantMessageByItemKey: [String: String] = [:]
    @ObservationIgnored var streamingSystemMessageByItemID: [String: String] = [:]
    // Phase callbacks for in-flight `git/runStackedAction` calls keyed by progressId.
    @ObservationIgnored var gitStackedActionProgressHandlers: [String: (String, String) -> Void] = [:]
    /// Rich metadata for command execution tool calls, keyed by itemId.
    var commandExecutionDetailsByItemID: [String: CommandExecutionDetails] = [:]
    // Debounces disk writes while streaming to keep UI responsive.
    @ObservationIgnored var messagePersistenceDebounceTask: Task<Void, Never>?
    // Coalesces high-frequency assistant deltas before they mutate observed timeline state.
    @ObservationIgnored var pendingAssistantDeltaByStreamID: [String: String] = [:]
    @ObservationIgnored var pendingAssistantDeltaContextByStreamID: [String: (threadId: String, turnId: String, itemId: String?, assistantPhase: String?, isReplayed: Bool)] = [:]
    @ObservationIgnored var pendingAssistantDeltaStreamOrder: [String] = []
    @ObservationIgnored var pendingAssistantDeltaFlushTask: Task<Void, Never>?
    // Coalesces multiple invalidateAssistantRevertStates() calls within the same run loop tick into one refresh.
    var coalescedRevertRefreshTask: Task<Void, Never>?
    // Dedupes completion payloads when servers omit turn/item identifiers.
    var assistantCompletionFingerprintByThread: [String: (text: String, timestamp: Date)] = [:]
    // Dedupes concise activity feed lines per thread/turn to avoid visual spam.
    var recentActivityLineByThread: [String: CodexRecentActivityLine] = [:]
    var contextWindowUsageByThread: [String: ContextWindowUsage] = [:]
    var rateLimitBuckets: [CodexRateLimitBucket] = []
    // Distinguishes "not loaded yet" from "loaded successfully, but no visible buckets exist".
    var hasResolvedRateLimitsSnapshot = false
    var isLoadingRateLimits = false
    var rateLimitsErrorMessage: String?
    var threadIdByTurnID: [String: String] = [:]
    var hydratedThreadIDs: Set<String> = []
    var loadingThreadIDs: Set<String> = []
    // Cursor-backed history pages let large chats open from the recent tail first.
    var olderThreadHistoryCursorByThreadID: [String: JSONValue] = [:]
    var exhaustedOlderThreadHistoryCursorByThreadID: [String: JSONValue] = [:]
    var loadingOlderThreadHistoryIDs: Set<String> = []
    var threadTimelineProjectionLimitByThreadID: [String: Int] = [:]
    var initialTurnsLoadedByThreadID: Set<String> = []
    var threadsWithAuthoritativeLocalHistoryStart: Set<String> = []
    var olderHistoryLoadErrorByThreadID: [String: String] = [:]
    @ObservationIgnored var subagentMetadataLoadingThreadIDs: Set<String> = []
    var resumedThreadIDs: Set<String> = []
    // Coalesces per-thread thread/read history fetches so reconcile work can await the same RPC.
    @ObservationIgnored var threadHistoryLoadTaskByThreadID: [String: Task<ThreadHistoryLoadOutcome, Error>] = [:]
    // Secure-transport replay is history catch-up, not live runtime activity.
    @ObservationIgnored var isApplyingReplayedBridgeEvent = false
    // Lets a late force caller upgrade an in-flight history load without spawning another thread/read.
    @ObservationIgnored var forcedHistoryLoadThreadIDs: Set<String> = []
    // Marks desktop mirror source handoffs that need canonical history to replace stale mirror rows.
    @ObservationIgnored var pendingCanonicalSourceReplacementThreadIDs: Set<String> = []
    // Preserves callers that need "not materialized" reads to keep retrying instead of marking hydrated.
    @ObservationIgnored var deferHydratedMarkForNotMaterializedThreadIDs: Set<String> = []
    // Coalesces per-thread resume work so rapid thread switches reuse the same in-flight refresh.
    @ObservationIgnored var threadResumeTaskByThreadID: [String: Task<CodexThread?, Error>] = [:]
    // Remembers which cwd/model pair an in-flight resume is actually targeting.
    @ObservationIgnored var threadResumeRequestSignatureByThreadID: [String: CodexThreadResumeRequestSignature] = [:]
    // Lets a late force caller upgrade an in-flight resume without spawning another RPC.
    @ObservationIgnored var forcedResumeEscalationThreadIDs: Set<String> = []
    // Coalesces running-state refreshes so foreground recovery cannot stampede the same thread.
    @ObservationIgnored var turnStateRefreshTaskByThreadID: [String: Task<Bool, Never>] = [:]
    // Coalesces the full running-thread catch-up pipeline so open/foreground/reconnect share one path.
    @ObservationIgnored var runningThreadCatchupTaskByThreadID: [String: Task<RunningThreadCatchupOutcome, Never>] = [:]
    // Lets a late foreground/open caller upgrade an in-flight running catch-up into a forced resume.
    @ObservationIgnored var forcedRunningCatchupEscalationThreadIDs: Set<String> = []
    // Invalidates stale async completions after archive/delete/reconnect tears refresh work down.
    @ObservationIgnored var threadRefreshGenerationByThreadID: [String: UInt64] = [:]
    // Throttles expensive forced resumes while the user bounces between running chats.
    @ObservationIgnored var lastForcedRunningResumeAtByThread: [String: Date] = [:]
    // Marks threads that used a lightweight running catch-up and still need one canonical history pass later.
    @ObservationIgnored var threadsNeedingCanonicalHistoryReconcile: Set<String> = []
    // Tracks first-paint pages rebuilt from local Codex JSONL so the next
    // quiet refresh asks the bridge for canonical app-server history.
    @ObservationIgnored var provisionalPaginatedHistoryThreadIDs: Set<String> = []
    // Remembers which large closed chats already completed the one required canonical refresh after local-first paint.
    @ObservationIgnored var threadsWithSatisfiedDeferredHistoryHydration: Set<String> = []
    // Keeps post-run canonical reconcile work coalesced to one task per thread.
    @ObservationIgnored var canonicalHistoryReconcileTaskByThreadID: [String: Task<Void, Never>] = [:]
    // Tracks delayed retry timers for canonical reconcile so teardown can cancel the backoff too.
    @ObservationIgnored var canonicalHistoryReconcileRetryTaskByThreadID: [String: Task<Void, Never>] = [:]
    // Increases retry spacing for chats whose first history page remains unavailable.
    @ObservationIgnored var canonicalHistoryReconcileRetryAttemptByThreadID: [String: Int] = [:]
    // Coalesces sidebar/bootstrap thread/list refreshes so launch paths do not duplicate the same fetch.
    @ObservationIgnored var threadListFetchTaskByLimit: [String: (id: UUID, task: Task<[CodexThread], Error>)] = [:]
    var isAppInForeground = true
    var threadListSyncTask: Task<Void, Never>?
    var activeThreadSyncTask: Task<Void, Never>?
    var runningThreadWatchSyncTask: Task<Void, Never>?
    var postConnectSyncTask: Task<Void, Never>?
    // Keeps the phone-side account UI in sync while ChatGPT login is being completed on the Mac.
    var gptAccountLoginSyncTask: Task<Void, Never>?
    var postConnectSyncToken: UUID?
    var connectedServerIdentity: String?
    // Tracks whether the bridge is proxying a real Codex endpoint or a spawned local app-server.
    var codexTransportMode: CodexRuntimeTransportMode = .unknown

    // Remembers whether the current plan flow is staying native or has fallen back to inferred UI.
    var planSessionSourceByThread: [String: CodexPlanSessionSource] = [:] {
        didSet {
            persistPlanSessionSources()
        }
    }
    var runningThreadWatchByID: [String: CodexRunningThreadWatch] = [:]
    var mirroredRunningCatchupThreadIDs: Set<String> = []
    var lastMirroredRunningCatchupAtByThread: [String: Date] = [:]
    var localNetworkAuthorizationStatus: LocalNetworkAuthorizationStatus = .unknown
    var backgroundTurnGraceTaskID: UIBackgroundTaskIdentifier = .invalid
    var hasConfiguredNotifications = false
    var runCompletionNotificationDedupedAt: [String: Date] = [:]
    var structuredUserInputNotificationDedupedAt: [String: Date] = [:]
    var notificationCenterDelegateProxy: CodexNotificationCenterDelegateProxy?
    var notificationObserverTokens: [NSObjectProtocol] = []
    var remoteNotificationDeviceToken: String?
    var lastPushRegistrationSignature: String?
    var shouldAutoReconnectOnForeground = false
    // Test hook so connection handling can model `.inactive` without waiting for real app lifecycle changes.
    @ObservationIgnored var applicationStateProvider: () -> UIApplication.State = { UIApplication.shared.applicationState }
    var backgroundTurnGraceExpiredUntilForeground = false
    var secureSession: CodexSecureSession?
    var pendingHandshake: CodexPendingHandshake?
    var phoneIdentityState: CodexPhoneIdentityState
    var trustedMacRegistry: CodexTrustedMacRegistry
    var currentTrustedMacDeviceId: String?
    var lastTrustedMacDeviceId: String?
    var previousTrustedMacDeviceId: String?
    @ObservationIgnored var macScopedContextOverrideDeviceId: String?
    @ObservationIgnored var suspendAutomaticMacScopedPersistence = false
    @ObservationIgnored var isApplyingMacScopedState = false
    var pendingSecureControlContinuations: [String: [CodexSecureControlWaiter]] = [:]
    var bufferedSecureControlMessages: [String: [String]] = [:]
    // Assistant-scoped patch ledger used by the revert-changes flow.
    var aiChangeSetsByID: [String: AIChangeSet] = [:]
    var aiChangeSetIDByTurnKey: [AIChangeSetTurnKey: String] = [:]
    var aiChangeSetIDByAssistantMessageID: [String: String] = [:]
    @ObservationIgnored var workspaceCheckpointCopyTaskByTurnID: [String: Task<Void, Never>] = [:]
    // Keeps hot-path thread lookups O(1) instead of rescanning the full sidebar list.
    @ObservationIgnored var threadByID: [String: CodexThread] = [:]
    @ObservationIgnored var threadIndexByID: [String: Int] = [:]
    @ObservationIgnored var firstLiveThreadIDCache: String?
    @ObservationIgnored var subagentIdentityByThreadID: [String: CodexSubagentIdentityEntry] = [:]
    @ObservationIgnored var subagentIdentityByAgentID: [String: CodexSubagentIdentityEntry] = [:]
    // Canonical repo roots keyed by observed working directories from bridge git/status responses.
    var repoRootByWorkingDirectory: [String: String] = [:]
    var knownRepoRoots: Set<String> = []
    // Service-owned per-thread UI state keeps the active chat isolated from unrelated thread mutations.
    @ObservationIgnored var threadTimelineStateByThread: [String: ThreadTimelineState] = [:]
    @ObservationIgnored var autoApprovalRetryTokensByReviewKey: [String: CodexAutoApprovalRetryToken] = [:]
    @ObservationIgnored var autoApprovalRetryReviewIDsInFlight: Set<String> = []
    @ObservationIgnored var forkedFromThreadIDByThreadID: [String: String] = [:]
    @ObservationIgnored var renamedThreadNameByThreadID: [String: String] = [:]
    @ObservationIgnored var associatedManagedWorktreePathByThreadID: [String: String] = [:]
    @ObservationIgnored var authoritativeProjectPathByThreadID: [String: String] = [:]
    var pinnedThreadIDs: [String] = []
    @ObservationIgnored var pinnedThreadSnapshotsByRootID: [String: [CodexThread]] = [:]
    @ObservationIgnored var snapshotOnlyPinnedThreadIDs: Set<String> = []
    @ObservationIgnored var stoppedTurnIDsByThread: [String: Set<String>] = [:]
    // Lazily rebuilt id->index maps keep hot-path message lookups out of repeated linear scans.
    @ObservationIgnored var messageIndexCacheByThread: [String: [String: Int]] = [:]
    @ObservationIgnored var latestAssistantOutputByThread: [String: String] = [:]
    @ObservationIgnored var latestAssistantMessageIDByThread: [String: String] = [:]
    @ObservationIgnored var latestRepoAffectingMessageSignalByThread: [String: String] = [:]
    @ObservationIgnored var assistantRevertStateCacheByThread: [String: AssistantRevertStateCacheEntry] = [:]
    @ObservationIgnored var assistantRevertStateRevision: Int = 0
    @ObservationIgnored var busyRepoRoots: Set<String> = []
    @ObservationIgnored var busyRepoRootsRevision: Int = 0
    @ObservationIgnored var pendingSystemDeltasByKey: [String: PendingSystemStreamingDeltas] = [:]
    @ObservationIgnored var systemDeltaFlushTasksByKey: [String: Task<Void, Never>] = [:]
    @ObservationIgnored var systemNoticeDismissTasksByID: [UUID: Task<Void, Never>] = [:]

    let encoder: JSONEncoder
    let decoder: JSONDecoder
    let messagePersistence = CodexMessagePersistence()
    let composerDraftPersistence = CodexComposerDraftPersistence()
    let aiChangeSetPersistence = AIChangeSetPersistence()
    let defaults: UserDefaults
    let userNotificationCenter: CodexUserNotificationCentering
    let remoteNotificationRegistrar: CodexRemoteNotificationRegistering

    static let selectedModelIdDefaultsKey = "codex.selectedModelId"
    static let selectedGitWriterModelIdDefaultsKey = "codex.selectedGitWriterModelId"
    static let selectedReasoningEffortDefaultsKey = "codex.selectedReasoningEffort"
    static let selectedServiceTierDefaultsKey = "codex.selectedServiceTier"
    static let threadRuntimeOverridesDefaultsKey = "codex.threadRuntimeOverrides"
    static let planSessionSourcesDefaultsKey = "codex.planSessionSources"
    static let selectedAccessModeDefaultsKey = "codex.selectedAccessMode"
    static let locallyArchivedThreadIDsKey = "codex.locallyArchivedThreadIDs"
    static let locallyDeletedThreadIDsKey = "codex.locallyDeletedThreadIDs"
    static let forkedThreadOriginsDefaultsKey = "codex.forkedThreadOrigins"
    static let renamedThreadNamesDefaultsKey = "codex.renamedThreadNames"
    static let pinnedThreadIDsDefaultsKey = "codex.pinnedThreadIDs"
    static let pinnedThreadSnapshotsDefaultsKey = "codex.pinnedThreadSnapshots"
    static let associatedManagedWorktreePathsDefaultsKey = "codex.associatedManagedWorktreePaths"
    static let turnTerminalStatesDefaultsKey = "codex.turnTerminalStates"
    static let threadHistoryPaginationStateDefaultsKey = "codex.threadHistoryPaginationState"
    static let notificationsPromptedDefaultsKey = "codex.notifications.prompted"
    static let keepMacAwakeWhileBridgeRunsDefaultsKey = "codex.keepMacAwakeWhileBridgeRuns"
    static let enableWebTerminalOnBridgeDefaultsKey = "codex.enableWebTerminalOnBridge"

    init(
        encoder: JSONEncoder = JSONEncoder(),
        decoder: JSONDecoder = JSONDecoder(),
        defaults: UserDefaults = .standard,
        userNotificationCenter: CodexUserNotificationCentering = UNUserNotificationCenter.current(),
        remoteNotificationRegistrar: CodexRemoteNotificationRegistering = CodexApplicationRemoteNotificationRegistrar()
    ) {
        self.encoder = encoder
        self.decoder = decoder
        self.defaults = defaults
        self.userNotificationCenter = userNotificationCenter
        self.remoteNotificationRegistrar = remoteNotificationRegistrar
        self.phoneIdentityState = codexPhoneIdentityStateFromSecureStore()
        self.trustedMacRegistry = codexTrustedMacRegistryFromSecureStore()
        self.currentTrustedMacDeviceId = SecureStore.readString(for: CodexSecureKeys.currentTrustedMacDeviceId)
        self.lastTrustedMacDeviceId = SecureStore.readString(for: CodexSecureKeys.lastTrustedMacDeviceId)
        self.messagesByThread = [:]
        self.composerDraftsByThreadID = [:]
        rebuildSubagentIdentityDirectory()
        self.aiChangeSetsByID = [:]
        self.aiChangeSetIDByTurnKey = [:]
        self.aiChangeSetIDByAssistantMessageID = [:]
        self.systemNotices = []

        let savedModelId = defaults.string(forKey: Self.selectedModelIdDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let hasSavedModelId = savedModelId?.isEmpty == false
        self.hasPersistedSelectedModelId = hasSavedModelId
        self.selectedModelId = hasSavedModelId ? savedModelId : nil

        let savedGitWriterModelId = defaults.string(forKey: Self.selectedGitWriterModelIdDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        self.selectedGitWriterModelId = (savedGitWriterModelId?.isEmpty == false) ? savedGitWriterModelId : nil

        let savedReasoning = defaults.string(forKey: Self.selectedReasoningEffortDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        self.selectedReasoningEffort = (hasSavedModelId && savedReasoning?.isEmpty == false)
            ? savedReasoning
            : nil

        if defaults.object(forKey: Self.keepMacAwakeWhileBridgeRunsDefaultsKey) != nil {
            self.keepMacAwakeWhileBridgeRuns = defaults.bool(forKey: Self.keepMacAwakeWhileBridgeRunsDefaultsKey)
        } else {
            self.keepMacAwakeWhileBridgeRuns = false
        }
        if defaults.object(forKey: Self.enableWebTerminalOnBridgeDefaultsKey) != nil {
            self.enableWebTerminalOnBridge = defaults.bool(forKey: Self.enableWebTerminalOnBridgeDefaultsKey)
        } else {
            self.enableWebTerminalOnBridge = false
        }

        self.threadRuntimeOverridesByThreadID = [:]
        self.planSessionSourceByThread = [:]
        self.forkedFromThreadIDByThreadID = [:]
        self.renamedThreadNameByThreadID = [:]
        self.pinnedThreadIDs = []
        self.pinnedThreadSnapshotsByRootID = [:]
        self.associatedManagedWorktreePathByThreadID = [:]
        self.terminalStateByTurnID = [:]
        self.projectedTerminalStateByThreadID = [:]

        let savedServiceTier = defaults.string(forKey: Self.selectedServiceTierDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if savedServiceTier == "flex" {
            self.selectedServiceTier = nil
        } else if let savedServiceTier,
           let parsedServiceTier = CodexServiceTier(rawValue: savedServiceTier) {
            self.selectedServiceTier = parsedServiceTier
        } else {
            self.selectedServiceTier = nil
        }

        if let savedAccessMode = defaults.string(forKey: Self.selectedAccessModeDefaultsKey),
           let parsedAccessMode = CodexAccessMode(rawValue: savedAccessMode) {
            self.selectedAccessMode = parsedAccessMode
        } else {
            self.selectedAccessMode = .onRequest
        }

        self.gptAccountSnapshot = codexGPTAccountInitialSnapshot()

        // Restore relay session from Keychain
        self.relaySessionId = SecureStore.readString(for: CodexSecureKeys.relaySessionId)
        self.relayUrl = SecureStore.readString(for: CodexSecureKeys.relayUrl)
        self.relayMacDeviceId = SecureStore.readString(for: CodexSecureKeys.relayMacDeviceId)
        self.relayMacIdentityPublicKey = SecureStore.readString(for: CodexSecureKeys.relayMacIdentityPublicKey)
        if let rawProtocolVersion = SecureStore.readString(for: CodexSecureKeys.relayProtocolVersion),
           let parsedProtocolVersion = Int(rawProtocolVersion) {
            self.relayProtocolVersion = parsedProtocolVersion
        } else {
            self.relayProtocolVersion = codexSecureProtocolVersion
        }
        if let rawLastAppliedSeq = SecureStore.readString(for: CodexSecureKeys.relayLastAppliedBridgeOutboundSeq),
           let parsedLastAppliedSeq = Int(rawLastAppliedSeq) {
            self.lastAppliedBridgeOutboundSeq = parsedLastAppliedSeq
        }
        self.lastAppliedBridgeReplayEpoch = SecureStore.readString(for: CodexSecureKeys.relayBridgeReplayEpoch)
        migrateCurrentTrustedMacDeviceIdIfNeeded()
        migrateLegacyMacScopedDefaultsIfNeeded()
        loadCurrentMacScopedDefaultsState()
        loadCurrentMacScopedLocalState()
        self.remoteNotificationDeviceToken = SecureStore.readString(for: CodexSecureKeys.pushDeviceToken)
        if let relayMacDeviceId,
           let trustedMac = trustedMacRegistry.records[relayMacDeviceId] {
            self.secureConnectionState = .trustedMac
            self.secureMacFingerprint = codexSecureFingerprint(for: trustedMac.macIdentityPublicKey)
        } else if let trustedMac = currentTrustedMacRecord {
            self.secureConnectionState = .liveSessionUnresolved
            self.secureMacFingerprint = codexSecureFingerprint(for: trustedMac.macIdentityPublicKey)
        }
        rebuildThreadLookupCaches()
    }
}
