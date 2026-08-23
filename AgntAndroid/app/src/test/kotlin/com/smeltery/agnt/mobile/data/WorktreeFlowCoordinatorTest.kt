package com.smeltery.agnt.mobile.data

import com.smeltery.agnt.mobile.core.error.AgentServiceError
import com.smeltery.agnt.mobile.core.model.ActiveProvider
import com.smeltery.agnt.mobile.core.model.CodexAccessMode
import com.smeltery.agnt.mobile.core.model.CodexBridgeUpdatePrompt
import com.smeltery.agnt.mobile.core.model.CodexCollaborationModeKind
import com.smeltery.agnt.mobile.core.model.CodexImageAttachment
import com.smeltery.agnt.mobile.core.model.CodexMessage
import com.smeltery.agnt.mobile.core.model.CodexModelOption
import com.smeltery.agnt.mobile.core.model.CodexServiceTier
import com.smeltery.agnt.mobile.core.model.CodexThread
import com.smeltery.agnt.mobile.core.model.ContextWindowUsage
import com.smeltery.agnt.mobile.core.model.JSONValue
import com.smeltery.agnt.mobile.core.model.PendingApprovalDecision
import com.smeltery.agnt.mobile.core.model.PendingApprovalRequest
import com.smeltery.agnt.mobile.core.model.PendingStructuredInputRequest
import com.smeltery.agnt.mobile.core.model.RPCError
import com.smeltery.agnt.mobile.core.model.RPCMessage
import com.smeltery.agnt.mobile.core.model.SystemNotice
import com.smeltery.agnt.mobile.core.transport.ConnectionState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class WorktreeFlowCoordinatorTest {
    @Test
    fun startNewManagedWorktreeChat_createThenStartThreadWithWorktreeCwd() =
        runTest {
            val log = mutableListOf<String>()
            val repo =
                WorktreeRecordingRepository(
                    onSendRequest = { method, _ ->
                        log.add("rpc:$method")
                        createManagedWorktreeResult("/wt/new")
                    },
                    onStartThread = { cwd ->
                        log.add("startThread:$cwd")
                        CodexThread(id = "t1", title = "New", cwd = cwd)
                    },
                )

            val thread = WorktreeFlowCoordinator(repo).startNewManagedWorktreeChat("/base", "main")

            assertEquals("t1", thread.id)
            assertEquals("/wt/new", thread.cwd)
            assertEquals(listOf("rpc:git/createManagedWorktree", "startThread:/wt/new"), log)
        }

    @Test
    fun startNewManagedWorktreeChat_threadStartFails_cleanupRemovedWhenSafe() =
        runTest {
            val log = mutableListOf<String>()
            val repo =
                WorktreeRecordingRepository(
                    onSendRequest = { method, params ->
                        log.add("rpc:$method")
                        when (method) {
                            "git/createManagedWorktree" -> createManagedWorktreeResult("/wt/tmp")
                            "git/removeWorktree" -> {
                                log.add("removeCwd:${(params as JSONValue.Obj).map["cwd"]?.stringValue}")
                                successResult()
                            }
                            else -> error("unexpected $method")
                        }
                    },
                    onStartThread = { throw AgentServiceError.InvalidInput("thread start failed") },
                )

            val thrown =
                assertFailsWith<WorktreeFlowException> {
                    WorktreeFlowCoordinator(repo).startNewManagedWorktreeChat("/base", "main")
                }

            assertEquals(WorktreeFlowCleanupDispositionValue.removed, thrown.cleanupDisposition)
            assertTrue(thrown.cause is AgentServiceError.InvalidInput)
            assertTrue(thrown.message?.contains("thread start failed") == true)
            assertTrue(thrown.message?.contains("The temporary worktree was removed automatically.") == true)
            assertTrue(log.contains("removeCwd:/wt/tmp"))
        }

    @Test
    fun startNewManagedWorktreeChat_threadStartFails_networkPreservesWorktree() =
        runTest {
            val log = mutableListOf<String>()
            val repo =
                WorktreeRecordingRepository(
                    onSendRequest = { method, _ ->
                        log.add("rpc:$method")
                        createManagedWorktreeResult("/wt/tmp")
                    },
                    onStartThread = {
                        throw AgentServiceError.RpcFailure(
                            RPCError(code = -32000, message = "network timeout", data = null),
                        )
                    },
                )

            val thrown =
                assertFailsWith<WorktreeFlowException> {
                    WorktreeFlowCoordinator(repo).startNewManagedWorktreeChat("/base", "main")
                }

            assertEquals(WorktreeFlowCleanupDispositionValue.preserved, thrown.cleanupDisposition)
            assertTrue(thrown.message?.contains("kept") == true)
            assertEquals(0, log.count { it == "rpc:git/removeWorktree" })
        }

    @Test
    fun startNewManagedWorktreeChat_threadStartFails_cleanupFailurePreservesOriginalError() =
        runTest {
            val repo =
                WorktreeRecordingRepository(
                    onSendRequest = { method, _ ->
                        when (method) {
                            "git/createManagedWorktree" -> createManagedWorktreeResult("/wt/tmp")
                            "git/removeWorktree" -> throw AgentServiceError.InvalidInput("cleanup failed")
                            else -> error("unexpected $method")
                        }
                    },
                    onStartThread = { throw AgentServiceError.InvalidInput("thread start failed") },
                )

            val thrown =
                assertFailsWith<WorktreeFlowException> {
                    WorktreeFlowCoordinator(repo).startNewManagedWorktreeChat("/base", "main")
                }

            assertEquals(WorktreeFlowCleanupDispositionValue.failed, thrown.cleanupDisposition)
            assertTrue(thrown.cause is AgentServiceError.InvalidInput)
            assertTrue(thrown.message?.contains("thread start failed") == true)
            assertTrue(thrown.message?.contains("could not remove the temporary worktree") == true)
        }

    @Test
    fun handoffThreadToProjectPath_transferThenMoveThread() =
        runTest {
            val log = mutableListOf<String>()
            val repo =
                WorktreeRecordingRepository(
                    onSendRequest = { method, _ ->
                        log.add("rpc:$method")
                        transferResult(transferredChanges = true)
                    },
                    onMoveThread = { threadId, path ->
                        log.add("move:$threadId->$path")
                        CodexThread(id = threadId, title = "T", cwd = path)
                    },
                )

            val outcome = WorktreeFlowCoordinator(repo).handoffThreadToProjectPath("thread-1", "/src", "/dest")
            val moved = outcome as WorktreeFlowHandoffOutcome.Moved

            assertEquals("thread-1", moved.move.thread.id)
            assertEquals("/dest", moved.move.projectPath)
            assertTrue(moved.move.transferredChanges)
            assertEquals(listOf("rpc:git/transferManagedHandoff", "move:thread-1->/dest"), log)
        }

    @Test
    fun handoffThreadToProjectPath_transferNotSuccessfulNoMoveThread() =
        runTest {
            var moved = false
            val repo =
                WorktreeRecordingRepository(
                    onSendRequest = { _, _ ->
                        RPCMessage.success(
                            id = null,
                            result =
                                JSONValue.Obj(
                                    mapOf(
                                        "success" to JSONValue.Bool(false),
                                        "targetPath" to JSONValue.Str("/dest"),
                                        "transferredChanges" to JSONValue.Bool(false),
                                    ),
                                ),
                        )
                    },
                    onMoveThread = { _, _ ->
                        moved = true
                        CodexThread(id = "unused")
                    },
                )

            assertFailsWith<WorktreeHandoffTransferException> {
                WorktreeFlowCoordinator(repo).handoffThreadToProjectPath("thread-1", "/src", "/dest")
            }

            assertTrue(!moved)
        }

    @Test
    fun handoffThreadToWorktree_associatedMissingWithoutTransferReturnsMissingAssociatedWorktree() =
        runTest {
            val repo =
                WorktreeRecordingRepository(
                    onSendRequest = { _, _ ->
                        throw AgentServiceError.RpcFailure(
                            RPCError(
                                code = -32000,
                                message = "missing target",
                                data = JSONValue.Obj(mapOf("errorCode" to JSONValue.Str("missing_handoff_target"))),
                            ),
                        )
                    },
                )

            val outcome =
                WorktreeFlowCoordinator(repo).handoffThreadToWorktree(
                    threadId = "thread-1",
                    sourceProjectPath = "/local",
                    associatedWorktreePath = "/missing/wt",
                    baseBranchForNewWorktree = null,
                )

            assertEquals(WorktreeFlowHandoffOutcome.MissingAssociatedWorktree, outcome)
        }

    @Test
    fun handoffThreadToWorktree_createdWorktreeMoveFails_rollsBackThenCleansUp() =
        runTest {
            val log = mutableListOf<String>()
            val repo =
                WorktreeRecordingRepository(
                    onSendRequest = { method, params ->
                        log.add("rpc:$method:${(params as JSONValue.Obj).map["cwd"]?.stringValue}")
                        when (method) {
                            "git/createManagedWorktree" -> createManagedWorktreeResult("/wt/new", transferredChanges = true)
                            "git/transferManagedHandoff" -> transferResult(transferredChanges = true)
                            "git/removeWorktree" -> successResult()
                            else -> error("unexpected $method")
                        }
                    },
                    onMoveThread = { _, _ -> throw AgentServiceError.InvalidInput("move failed") },
                )

            val thrown =
                assertFailsWith<WorktreeFlowException> {
                    WorktreeFlowCoordinator(repo).handoffThreadToWorktree(
                        threadId = "thread-1",
                        sourceProjectPath = "/local",
                        associatedWorktreePath = null,
                        baseBranchForNewWorktree = "main",
                    )
                }

            assertTrue(thrown.message?.contains("move failed") == true)
            assertTrue(log.contains("rpc:git/transferManagedHandoff:/wt/new"))
            assertTrue(log.contains("rpc:git/removeWorktree:/wt/new"))
        }

    @Test
    fun handoffThreadToWorktree_rollbackFails_preservesWorktreeWithRecoveryMessage() =
        runTest {
            val repo =
                WorktreeRecordingRepository(
                    onSendRequest = { method, _ ->
                        when (method) {
                            "git/createManagedWorktree" -> createManagedWorktreeResult("/wt/new", transferredChanges = true)
                            "git/transferManagedHandoff" -> throw AgentServiceError.InvalidInput("rollback failed")
                            else -> error("unexpected $method")
                        }
                    },
                    onMoveThread = { _, _ -> throw AgentServiceError.InvalidInput("move failed") },
                )

            val thrown =
                assertFailsWith<WorktreeFlowException> {
                    WorktreeFlowCoordinator(repo).handoffThreadToWorktree(
                        threadId = "thread-1",
                        sourceProjectPath = "/local",
                        associatedWorktreePath = null,
                        baseBranchForNewWorktree = "main",
                    )
                }

            assertTrue(thrown.message?.contains("rollback failed") == true)
            assertTrue(thrown.message?.contains("temporary worktree was kept") == true)
        }

    @Test
    fun targetDirtyAndMismatchMessagesRemainDistinct() =
        runTest {
            val dirty = bridgeFailure("handoff_target_dirty", "dirty target")
            val mismatch = bridgeFailure("handoff_target_mismatch", "wrong checkout")
            assertEquals("dirty target", dirty.message)
            assertEquals("wrong checkout", mismatch.message)
        }

    @Test
    fun shouldCleanupWorktreeAfterFailedThreadStart_matchesRpcHeuristics() {
        assertTrue(WorktreeFlowCoordinator.shouldCleanupWorktreeAfterFailedThreadStart(AgentServiceError.InvalidInput("x")))
        assertTrue(!WorktreeFlowCoordinator.shouldCleanupWorktreeAfterFailedThreadStart(AgentServiceError.Disconnected))
        assertTrue(
            !WorktreeFlowCoordinator.shouldCleanupWorktreeAfterFailedThreadStart(
                AgentServiceError.RpcFailure(RPCError(code = -1, message = "network error", data = null)),
            ),
        )
    }

    private fun createManagedWorktreeResult(
        path: String,
        alreadyExisted: Boolean = false,
        transferredChanges: Boolean = false,
    ): RPCMessage =
        RPCMessage.success(
            id = null,
            result =
                JSONValue.Obj(
                    mapOf(
                        "worktreePath" to JSONValue.Str(path),
                        "alreadyExisted" to JSONValue.Bool(alreadyExisted),
                        "baseBranch" to JSONValue.Str("main"),
                        "headMode" to JSONValue.Str("branch"),
                        "transferredChanges" to JSONValue.Bool(transferredChanges),
                    ),
                ),
        )

    private fun transferResult(transferredChanges: Boolean): RPCMessage =
        RPCMessage.success(
            id = null,
            result =
                JSONValue.Obj(
                    mapOf(
                        "success" to JSONValue.Bool(true),
                        "targetPath" to JSONValue.Str("/dest"),
                        "transferredChanges" to JSONValue.Bool(transferredChanges),
                    ),
                ),
        )

    private fun successResult(): RPCMessage = RPCMessage.success(id = null, result = JSONValue.Obj(mapOf("success" to JSONValue.Bool(true))))

    private fun bridgeFailure(
        code: String,
        message: String,
    ): com.smeltery.agnt.mobile.services.git.GitActionsError.BridgeFailure =
        com.smeltery.agnt.mobile.services.git.GitActionsError
            .BridgeFailure(errorCode = code, message = message)
}

private class WorktreeRecordingRepository(
    private val onSendRequest: suspend (String, JSONValue?) -> RPCMessage,
    private val onStartThread: (suspend (String?) -> CodexThread)? = null,
    private val onMoveThread: (suspend (String, String) -> CodexThread)? = null,
    private val onForkThread: (suspend (String, String?) -> CodexThread)? = null,
) : CodexRepository {
    override val isSessionReady: StateFlow<Boolean> = MutableStateFlow(true)
    override val connectionState: StateFlow<ConnectionState> = MutableStateFlow(ConnectionState.Connected)
    override val threads: StateFlow<List<CodexThread>> = MutableStateFlow(emptyList())
    override val activeThreadId: StateFlow<String?> = MutableStateFlow(null)
    override val messagesByThread: StateFlow<Map<String, List<CodexMessage>>> = MutableStateFlow(emptyMap())
    override val runningTurnIdByThread: StateFlow<Map<String, String>> = MutableStateFlow(emptyMap())
    override val protectedRunningFallbackThreadIds: StateFlow<Set<String>> = MutableStateFlow(emptySet())
    override val availableModels: StateFlow<List<CodexModelOption>> = MutableStateFlow(emptyList())
    override val isLoadingModels: StateFlow<Boolean> = MutableStateFlow(false)
    override val modelsErrorMessage: StateFlow<String?> = MutableStateFlow(null)
    override val rateLimitBuckets: StateFlow<List<com.smeltery.agnt.mobile.core.model.CodexRateLimitBucket>> =
        MutableStateFlow(emptyList())
    override val isLoadingRateLimits: StateFlow<Boolean> = MutableStateFlow(false)
    override val rateLimitsErrorMessage: StateFlow<String?> = MutableStateFlow(null)
    override val hasResolvedRateLimitsSnapshot: StateFlow<Boolean> = MutableStateFlow(false)
    override val contextWindowUsageByThread: StateFlow<Map<String, ContextWindowUsage>> = MutableStateFlow(emptyMap())
    override val contextWindowUsageLoadingThreads: StateFlow<Set<String>> = MutableStateFlow(emptySet())
    override val contextWindowUsageErrorByThread: StateFlow<Map<String, String>> = MutableStateFlow(emptyMap())
    override val selectedModelId: StateFlow<String?> = MutableStateFlow(null)
    override val selectedReasoningEffort: StateFlow<String?> = MutableStateFlow(null)
    override val selectedAccessMode: StateFlow<CodexAccessMode> = MutableStateFlow(CodexAccessMode.onRequest)
    override val selectedServiceTier: StateFlow<CodexServiceTier?> = MutableStateFlow(null)
    override val pendingApprovalRequest: StateFlow<PendingApprovalRequest?> = MutableStateFlow(null)
    override val pendingStructuredInputRequest: StateFlow<PendingStructuredInputRequest?> = MutableStateFlow(null)
    override val bridgeSupportsVoiceTranscription: StateFlow<Boolean> = MutableStateFlow(true)
    override val activeProvider: StateFlow<ActiveProvider> = MutableStateFlow(ActiveProvider.Unknown)
    override val systemNotices: StateFlow<List<SystemNotice>> = MutableStateFlow(emptyList())

    override fun dismissSystemNotice(id: String) {}

    override val bridgeUpdatePrompt: StateFlow<CodexBridgeUpdatePrompt?> = MutableStateFlow(null)

    override suspend fun connect(
        serverUrl: String,
        token: String,
        role: String?,
    ) = error("unused")

    override suspend fun disconnect() = error("unused")

    override suspend fun setActiveThreadId(threadId: String?) = error("unused")

    override suspend fun refreshModels() = error("unused")

    override suspend fun refreshRateLimits() = error("unused")

    override suspend fun refreshContextWindowUsage(threadId: String) = error("unused")

    override suspend fun setSelectedModelId(modelId: String?) = error("unused")

    override suspend fun setSelectedReasoningEffort(reasoningEffort: String?) = error("unused")

    override suspend fun setSelectedAccessMode(accessMode: CodexAccessMode) = error("unused")

    override suspend fun setSelectedServiceTier(serviceTier: CodexServiceTier?) = error("unused")

    override suspend fun resolvePendingApproval(
        requestId: String,
        decision: PendingApprovalDecision,
    ) = error("unused")

    override suspend fun resolvePendingStructuredInput(
        requestId: String,
        answersByQuestionId: Map<String, List<String>>,
    ) = error("unused")

    override fun dismissBridgeUpdatePrompt() {}

    override suspend fun refreshThreads() = error("unused")

    override suspend fun syncThreadHistory(
        threadId: String,
        force: Boolean,
    ) = error("unused")

    override suspend fun sendRequest(
        method: String,
        params: JSONValue?,
    ): RPCMessage = onSendRequest(method, params)

    override suspend fun transcribeBridgeVoiceWav(
        wavBytes: ByteArray,
        durationSeconds: Double,
    ): String = error("unused")

    override suspend fun startThread(
        model: String?,
        cwd: String?,
        serviceTier: String?,
    ): CodexThread = onStartThread?.invoke(cwd) ?: error("startThread not stubbed")

    override suspend fun moveThreadToProjectPath(
        threadId: String,
        projectPath: String,
    ): CodexThread = onMoveThread?.invoke(threadId, projectPath) ?: error("moveThread not stubbed")

    override suspend fun forkThread(
        sourceThreadId: String,
        targetProjectPath: String?,
    ): CodexThread = onForkThread?.invoke(sourceThreadId, targetProjectPath) ?: error("forkThread not stubbed")

    override fun currentAuthoritativeProjectPathFor(threadId: String): String? = null

    override fun associatedManagedWorktreePathFor(threadId: String): String? = null

    override suspend fun startTurn(
        threadId: String,
        text: String,
        attachments: List<CodexImageAttachment>,
        skillMentions: List<com.smeltery.agnt.mobile.core.model.CodexTurnSkillMention>,
        fileMentions: List<com.smeltery.agnt.mobile.core.model.CodexTurnMention>,
        collaborationMode: CodexCollaborationModeKind?,
    ) = error("unused")

    override suspend fun interruptTurn(
        threadId: String,
        turnId: String?,
    ) = error("unused")

    override suspend fun sendNotification(
        method: String,
        params: JSONValue?,
    ) = error("unused")
}
