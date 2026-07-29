package com.dotbrains.agnt.mobile.services.agent

import android.content.Context
import com.dotbrains.agnt.mobile.core.model.ActiveProvider
import com.dotbrains.agnt.mobile.core.model.CodexAccessMode
import com.dotbrains.agnt.mobile.core.model.CodexBridgeUpdatePrompt
import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexModelOption
import com.dotbrains.agnt.mobile.core.model.CodexRateLimitBucket
import com.dotbrains.agnt.mobile.core.model.CodexSecureSession
import com.dotbrains.agnt.mobile.core.model.CodexServiceTier
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.CodexThreadGoal
import com.dotbrains.agnt.mobile.core.model.CodexTrustedMacRecord
import com.dotbrains.agnt.mobile.core.model.CommandExecutionDetails
import com.dotbrains.agnt.mobile.core.model.ContextWindowUsage
import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.core.model.PendingApprovalDecision
import com.dotbrains.agnt.mobile.core.model.PendingApprovalRequest
import com.dotbrains.agnt.mobile.core.model.PendingStructuredInputRequest
import com.dotbrains.agnt.mobile.core.model.RPCMessage
import com.dotbrains.agnt.mobile.core.model.ThreadHistoryPaginationState
import com.dotbrains.agnt.mobile.core.notification.AgntLocalNotificationPresenter
import com.dotbrains.agnt.mobile.core.persistence.CodexMessagePersistence
import com.dotbrains.agnt.mobile.core.persistence.MacScopedSessionStore
import com.dotbrains.agnt.mobile.core.persistence.SessionPersistence
import com.dotbrains.agnt.mobile.core.protocol.JsonRpcCodec
import com.dotbrains.agnt.mobile.core.security.SecureStore
import com.dotbrains.agnt.mobile.core.transport.ConnectionState
import com.dotbrains.agnt.mobile.core.transport.SecureControlMultiplexer
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.data.CommandExecutionDetailsStore
import com.dotbrains.agnt.mobile.data.IncomingEventRouter
import com.dotbrains.agnt.mobile.data.MessageTimelineStore
import com.dotbrains.agnt.mobile.data.QueuedTurnDraftPreview
import com.dotbrains.agnt.mobile.data.TurnDraftQueueStore
import com.dotbrains.agnt.mobile.services.agent.connection.AgntTrustedSessionResolveClient
import com.dotbrains.agnt.mobile.services.agent.threads.sendRequestImpl
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

private const val INITIAL_TIMELINE_TAIL_LIMIT = 16

/**
 * Android counterpart of [AgentService.swift](../../../../../../../../CodexMobile/CodexMobile/Services/AgentService.swift).
 *
 * Split across Kotlin files mirroring Swift extensions:
 * - [AgentServiceConnection] ← AgentService+Connection.swift
 * - [AgentServiceTransport] ← AgentService+Transport.swift
 * - [AgentServiceSecureTransport] ← AgentService+SecureTransport.swift
 * - [AgentServiceMessages] ← AgentService+Messages.swift
 * - [AgentServiceSync] ← AgentService+Sync.swift
 * - [AgentServiceHistory] ← AgentService+History.swift
 * - [AgentServiceVoice] ← AgentService+Voice.swift (bridge auth + ChatGPT transcribe)
 *
 * Push routing remains in [com.dotbrains.agnt.mobile.data.IncomingEventRouter] (Swift: AgentService+Incoming.swift).
 */
abstract class AgentServiceState(
    context: Context,
    internal val httpClient: OkHttpClient,
    internal val httpCallClient: OkHttpClient = httpClient,
    internal val secureStore: SecureStore,
    internal val sessionPersistence: SessionPersistence,
    messagePersistence: CodexMessagePersistence,
) : CodexRepository {
    internal val appContext = context.applicationContext

    internal val json =
        Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
        }

    internal val jsonRpc = JsonRpcCodec(json)

    internal val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Nullable so [resetBridgeSession] can run from extension files (no lateinit [isInitialized] outside the class). */
    internal var controlMux: SecureControlMultiplexer? = null
    internal var wireInbound: Channel<String>? = null
    internal var wireJob: Job? = null

    @Volatile
    internal var webSocket: WebSocket? = null

    @Volatile
    internal var secureSession: CodexSecureSession? = null
    internal val secureSessionLock = Any()

    @Volatile
    internal var sessionReady = false

    /**
     * Cleared when the bridge reports unsupported `voice/resolveAuth` / `voice/transcribe`
     * (e.g. non-Codex providers replying with `-32601` or the synthetic "managed externally"
     * shape). The composer observes this through [bridgeSupportsVoiceTranscription] to hide
     * the mic affordance once the bridge has confirmed it cannot service voice. Reset to
     * `true` in [com.dotbrains.agnt.mobile.services.resetBridgeSession] (parity iOS).
     */
    internal val _bridgeSupportsVoiceTranscription = MutableStateFlow(true)
    override val bridgeSupportsVoiceTranscription: StateFlow<Boolean> =
        _bridgeSupportsVoiceTranscription.asStateFlow()
    internal var supportsBridgeVoiceAuth: Boolean
        get() = _bridgeSupportsVoiceTranscription.value
        set(value) {
            _bridgeSupportsVoiceTranscription.value = value
        }

    /**
     * Which coding-agent backend the bridge is brokering for the current session. Set from
     * the `initialize` response's `result.providerId` (warm path). Defaults to
     * [ActiveProvider.Unknown] before the first initialize lands and is cleared back to
     * Unknown by `resetBridgeSession`. UI gates should treat Unknown as "don't pre-emptively
     * hide" — the existing fail-once-then-hide fallbacks (bridgeSupportsVoiceTranscription,
     * runCatching on thread/generateTitle) cover the gap.
     */
    internal val _activeProvider = MutableStateFlow(ActiveProvider.Unknown)
    override val activeProvider: StateFlow<ActiveProvider> = _activeProvider.asStateFlow()

    /**
     * Cleared when a `turn/start` or `thread/start` error indicates the bridge does not support `serviceTier`
     * for this session; reset in [com.dotbrains.agnt.mobile.services.resetBridgeSession] (parity iOS `supportsServiceTier`).
     */
    @Volatile
    internal var supportsServiceTier: Boolean = true

    @Volatile
    internal var closingByClient: Boolean = false

    internal val wireDropHandling = AtomicBoolean(false)

    internal val pendingRpc = ConcurrentHashMap<String, CompletableDeferred<RPCMessage>>()

    internal val _isSessionReady = MutableStateFlow(false)
    override val isSessionReady: StateFlow<Boolean> = _isSessionReady.asStateFlow()

    internal val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Offline)
    override val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    internal val _threads = MutableStateFlow(sessionPersistence.loadCachedThreads())
    override val threads: StateFlow<List<CodexThread>> = _threads.asStateFlow()

    internal val _activeThreadId = MutableStateFlow(sessionPersistence.loadLastActiveThreadId())
    override val activeThreadId: StateFlow<String?> = _activeThreadId.asStateFlow()

    /** Thread id → turn id attivo (running), per Stop / interrupt (J.3). */
    internal val _runningTurnIdByThread = MutableStateFlow<Map<String, String>>(emptyMap())
    override val runningTurnIdByThread: StateFlow<Map<String, String>> = _runningTurnIdByThread.asStateFlow()

    internal val _protectedRunningFallbackThreadIds = MutableStateFlow<Set<String>>(emptySet())
    override val protectedRunningFallbackThreadIds: StateFlow<Set<String>> =
        _protectedRunningFallbackThreadIds.asStateFlow()

    internal val _failedThreadIds = MutableStateFlow<Set<String>>(emptySet())
    override val failedThreadIds: StateFlow<Set<String>> = _failedThreadIds.asStateFlow()

    internal val _readyThreadIds = MutableStateFlow<Set<String>>(emptySet())
    override val readyThreadIds: StateFlow<Set<String>> = _readyThreadIds.asStateFlow()

    internal val _threadCompletionBannerThreadId = MutableStateFlow<String?>(null)
    internal val _threadCompletionBannerTitle = MutableStateFlow<String?>(null)
    override val threadCompletionBannerTitle: StateFlow<String?> = _threadCompletionBannerTitle.asStateFlow()

    internal val _pendingBranchPickerThreadId = MutableStateFlow<String?>(null)
    override val pendingBranchPickerThreadId: StateFlow<String?> = _pendingBranchPickerThreadId.asStateFlow()

    internal val _availableModels = MutableStateFlow<List<CodexModelOption>>(emptyList())
    override val availableModels: StateFlow<List<CodexModelOption>> = _availableModels.asStateFlow()

    internal val _isLoadingModels = MutableStateFlow(false)
    override val isLoadingModels: StateFlow<Boolean> = _isLoadingModels.asStateFlow()

    internal val _modelsErrorMessage = MutableStateFlow<String?>(null)
    override val modelsErrorMessage: StateFlow<String?> = _modelsErrorMessage.asStateFlow()

    internal val _rateLimitBuckets = MutableStateFlow<List<CodexRateLimitBucket>>(emptyList())
    override val rateLimitBuckets: StateFlow<List<CodexRateLimitBucket>> = _rateLimitBuckets.asStateFlow()

    internal val _isLoadingRateLimits = MutableStateFlow(false)
    override val isLoadingRateLimits: StateFlow<Boolean> = _isLoadingRateLimits.asStateFlow()

    internal val _rateLimitsErrorMessage = MutableStateFlow<String?>(null)
    override val rateLimitsErrorMessage: StateFlow<String?> = _rateLimitsErrorMessage.asStateFlow()

    internal val _hasResolvedRateLimitsSnapshot = MutableStateFlow(false)
    override val hasResolvedRateLimitsSnapshot: StateFlow<Boolean> = _hasResolvedRateLimitsSnapshot.asStateFlow()

    internal val _contextWindowUsageByThread = MutableStateFlow<Map<String, ContextWindowUsage>>(emptyMap())
    override val contextWindowUsageByThread: StateFlow<Map<String, ContextWindowUsage>> =
        _contextWindowUsageByThread.asStateFlow()

    internal val _contextWindowUsageLoadingThreads = MutableStateFlow<Set<String>>(emptySet())
    override val contextWindowUsageLoadingThreads: StateFlow<Set<String>> =
        _contextWindowUsageLoadingThreads.asStateFlow()

    internal val _contextWindowUsageErrorByThread = MutableStateFlow<Map<String, String>>(emptyMap())
    override val contextWindowUsageErrorByThread: StateFlow<Map<String, String>> =
        _contextWindowUsageErrorByThread.asStateFlow()

    private val runtimeSelection = sessionPersistence.loadRuntimeSelection()

    internal val _selectedModelId = MutableStateFlow(runtimeSelection.selectedModelId)
    override val selectedModelId: StateFlow<String?> = _selectedModelId.asStateFlow()

    internal val _selectedReasoningEffort = MutableStateFlow(runtimeSelection.selectedReasoningEffort)
    override val selectedReasoningEffort: StateFlow<String?> = _selectedReasoningEffort.asStateFlow()

    internal val _selectedAccessMode =
        MutableStateFlow(
            runCatching {
                runtimeSelection.selectedAccessMode?.let { CodexAccessMode.valueOf(it) }
            }.getOrNull() ?: CodexAccessMode.onRequest,
        )
    override val selectedAccessMode: StateFlow<CodexAccessMode> = _selectedAccessMode.asStateFlow()

    internal val _selectedServiceTier =
        MutableStateFlow(
            runCatching {
                runtimeSelection.selectedServiceTier?.let { CodexServiceTier.valueOf(it) }
            }.getOrNull(),
        )
    override val selectedServiceTier: StateFlow<CodexServiceTier?> = _selectedServiceTier.asStateFlow()

    internal val _pendingApprovalRequest = MutableStateFlow<PendingApprovalRequest?>(null)
    override val pendingApprovalRequest: StateFlow<PendingApprovalRequest?> =
        _pendingApprovalRequest.asStateFlow()

    internal val _pendingStructuredInputRequest = MutableStateFlow<PendingStructuredInputRequest?>(null)
    override val pendingStructuredInputRequest: StateFlow<PendingStructuredInputRequest?> =
        _pendingStructuredInputRequest.asStateFlow()

    internal val _bridgeUpdatePrompt = MutableStateFlow<CodexBridgeUpdatePrompt?>(null)
    override val bridgeUpdatePrompt: StateFlow<CodexBridgeUpdatePrompt?> =
        _bridgeUpdatePrompt.asStateFlow()

    /**
     * Once per session after [markServiceTierUnsupportedForCurrentBridge]; cleared on [resetBridgeSession]
     * (parity iOS `hasPresentedServiceTierBridgeUpdatePrompt`).
     */
    @Volatile
    internal var hasPresentedServiceTierBridgeUpdatePrompt: Boolean = false

    /** Cleared in [resetBridgeSession] (parity iOS `supportsThreadFork`). */
    @Volatile
    internal var supportsThreadFork: Boolean = true

    @Volatile
    internal var hasPresentedThreadForkBridgeUpdatePrompt: Boolean = false

    /**
     * Multi-device ("My Devices") state. Mac-scoped local session/UI snapshots are namespaced per
     * paired computer so switching devices restores that computer's cached threads, active thread,
     * renames, and runtime selections. See [AgentServiceTrustedDevices] /
     * [com.dotbrains.agnt.mobile.services.agent.devices.AgentServiceDeviceSwitch].
     */
    internal val macScopedSessionStore = MacScopedSessionStore(sessionPersistence, appContext)

    internal val _trustedDevices = MutableStateFlow<List<CodexTrustedMacRecord>>(emptyList())
    override val trustedDevices: StateFlow<List<CodexTrustedMacRecord>> = _trustedDevices.asStateFlow()

    internal val _switchingDeviceId = MutableStateFlow<String?>(null)
    override val switchingDeviceId: StateFlow<String?> = _switchingDeviceId.asStateFlow()

    internal val _deviceSwitchNotice = MutableStateFlow<String?>(null)
    override val deviceSwitchNotice: StateFlow<String?> = _deviceSwitchNotice.asStateFlow()

    internal val _currentTrustedMacDeviceId = MutableStateFlow<String?>(null)
    override val currentTrustedMacDeviceId: StateFlow<String?> = _currentTrustedMacDeviceId.asStateFlow()

    internal val _previousTrustedMacDeviceId = MutableStateFlow<String?>(null)
    override val previousTrustedMacDeviceId: StateFlow<String?> = _previousTrustedMacDeviceId.asStateFlow()

    internal val _relayMacDeviceId = MutableStateFlow<String?>(null)
    override val relayMacDeviceId: StateFlow<String?> = _relayMacDeviceId.asStateFlow()

    /** Lazily constructed on first trusted-session resolve; cancellable across a device switch. */
    internal var trustedSessionResolveClientLazy: AgntTrustedSessionResolveClient? = null
    internal val deviceSwitchMutex = Mutex()
    internal var isCancellingDeviceSwitch = false

    /**
     * Forces mac-scoped persistence/load to target a specific device while a switch is mid-flight,
     * overriding the persisted "current" id until the new session settles.
     */
    internal var macScopedContextOverrideDeviceId: String? = null

    /** Suppresses automatic mac-scoped saves during a switch so partial state is never persisted. */
    internal var suspendAutomaticMacScopedPersistence = false

    /** Guards reentrant StateFlow writes while applying a loaded mac-scoped snapshot. */
    internal var isApplyingMacScopedState = false

    internal val turnDraftQueueStore = TurnDraftQueueStore()

    internal val pendingApprovalResponders =
        ConcurrentHashMap<String, (PendingApprovalDecision) -> Unit>()
    internal val pendingStructuredInputResponders =
        ConcurrentHashMap<String, (answersByQuestionId: Map<String, List<String>>) -> Unit>()

    internal val messageTimelineStore =
        MessageTimelineStore(
            persistence = messagePersistence,
            lastActiveThreadId = sessionPersistence.loadLastActiveThreadId(),
            initialTailLimit = INITIAL_TIMELINE_TAIL_LIMIT,
        )
    internal val commandExecutionDetailsStore = CommandExecutionDetailsStore()
    internal val systemNoticesStore =
        com.dotbrains.agnt.mobile.data
            .SystemNoticesStore(scope = scope)
    override val systemNotices: StateFlow<List<com.dotbrains.agnt.mobile.core.model.SystemNotice>> =
        systemNoticesStore.notices

    override fun dismissSystemNotice(id: String) {
        systemNoticesStore.dismiss(id)
    }

    internal val messagePersistence = messagePersistence

    /** Local-only background alerts (turn completion, approvals, structured input). */
    internal val localNotificationPresenter = AgntLocalNotificationPresenter(appContext)

    override val messagesByThread: StateFlow<Map<String, List<CodexMessage>>> =
        messageTimelineStore.messagesByThread
    internal val _threadGoalsByThread = MutableStateFlow<Map<String, CodexThreadGoal>>(emptyMap())
    override val threadGoalsByThread: StateFlow<Map<String, CodexThreadGoal>> =
        _threadGoalsByThread.asStateFlow()
    override val commandExecutionDetailsByItemId: StateFlow<Map<String, CommandExecutionDetails>> =
        commandExecutionDetailsStore.detailsByItemId

    override val turnDraftQueueDepthByThread: StateFlow<Map<String, Int>> =
        turnDraftQueueStore.depthByThread
    override val turnDraftQueuePreviewByThread: StateFlow<Map<String, List<QueuedTurnDraftPreview>>> =
        turnDraftQueueStore.previewByThread

    internal val hydratedThreadIds = Collections.synchronizedSet(mutableSetOf<String>())
    internal val _threadHistoryPaginationByThread =
        MutableStateFlow<Map<String, ThreadHistoryPaginationState>>(emptyMap())
    override val threadHistoryPaginationByThread: StateFlow<Map<String, ThreadHistoryPaginationState>> =
        _threadHistoryPaginationByThread.asStateFlow()
    internal val _loadingOlderHistoryThreadIds = MutableStateFlow<Set<String>>(emptySet())
    override val loadingOlderHistoryThreadIds: StateFlow<Set<String>> =
        _loadingOlderHistoryThreadIds.asStateFlow()
    internal val _olderHistoryErrorByThread = MutableStateFlow<Map<String, String>>(emptyMap())
    override val olderHistoryErrorByThread: StateFlow<Map<String, String>> =
        _olderHistoryErrorByThread.asStateFlow()

    /** Thread ids that already received a successful `thread/resume` this session — parity iOS `resumedThreadIDs`. */
    internal val resumedThreadIds = Collections.synchronizedSet(mutableSetOf<String>())

    /**
     * In-flight same-thread rebind: preferred cwd until [thread/list]/[thread/read] match (parity
     * iOS [authoritativeProjectPathByThreadID] / [moveThreadToProjectPath]).
     */
    internal val authoritativeProjectPathByThreadId = ConcurrentHashMap<String, String>()

    internal val persistedThreadRenameById =
        ConcurrentHashMap<String, String>().also {
            it.putAll(sessionPersistence.loadThreadRenames())
        }

    /** First Codex managed worktree path associated with a thread for handoff heuristics. */
    internal val associatedManagedWorktreePathByThreadId =
        ConcurrentHashMap<String, String>().also {
            it.putAll(sessionPersistence.loadAssociatedManagedWorktreePaths())
        }

    /**
     * When set, [sendRequestImpl] (not handshake) uses this instead of the wire. Used for JVM tests.
     * Parity: iOS [requestTransportOverride] on [AgentService] for `CodexThreadProjectRoutingTests`.
     */
    @Volatile
    internal var testRpcRequestHandler: (suspend (String, JSONValue?) -> RPCMessage)? = null
    internal val loadingHistory = ConcurrentHashMap.newKeySet<String>()
    internal var supportsTurnCollaborationMode = true
    internal var supportsStructuredSkillInput = true
    internal var supportsStructuredMentionInput = true
}
