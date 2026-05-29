package com.dotbrains.agnt.mobile.services

import com.dotbrains.agnt.mobile.core.error.AgentServiceError
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.RPCError
import com.dotbrains.agnt.mobile.ui.turn.BranchPickerCloseCause
import com.dotbrains.agnt.mobile.ui.turn.shouldConsumeBranchPickerOpenRequest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class NewThreadCreationFlowTest {
    @Test
    fun backendFlow_publishesThenResumesBeforeActivatingWithoutAutoBranchPicker() =
        runTest {
            val started =
                CodexThread(
                    id = "thread-1",
                    title = "New Thread",
                    cwd = "/repo",
                    model = "gpt-test",
                )
            val resumed = started.copy(title = "Live Thread")
            val sink =
                RecordingNewThreadOpenSink(
                    resumedThread = resumed,
                )

            val result =
                runNewThreadOpenFlow(
                    thread = started,
                    normalizedCwd = "/repo",
                    sink = sink,
                )

            assertEquals(resumed, result)
            assertEquals(
                listOf(
                    "publish:thread-1",
                    "resume:thread-1:/repo:gpt-test",
                    "sync:thread-1",
                    "activate:thread-1",
                ),
                sink.events,
            )
        }

    @Test
    fun backendFlow_resumeFailureDoesNotActivateOrConsumeBranchPickerRequest() =
        runTest {
            val sink =
                RecordingNewThreadOpenSink(
                    resumeFailure = AgentServiceError.Disconnected,
                )

            assertFailsWith<AgentServiceError.Disconnected> {
                runNewThreadOpenFlow(
                    thread = CodexThread(id = "thread-1", cwd = "/repo"),
                    normalizedCwd = "/repo",
                    sink = sink,
                )
            }

            assertEquals(
                listOf(
                    "publish:thread-1",
                    "resume:thread-1:/repo:null",
                ),
                sink.events,
            )
        }

    @Test
    fun backendFlow_missingRolloutActivatesButDoesNotRequireResumeForEmptyNewThread() =
        runTest {
            val sink =
                RecordingNewThreadOpenSink(
                    resumeFailure =
                        AgentServiceError.RpcFailure(
                            RPCError(
                                code = -32600,
                                message = "no rollout found for thread id thread-1",
                                data = null,
                            ),
                        ),
                )

            val started =
                CodexThread(
                    id = "thread-1",
                    cwd = "/repo",
                    model = "gpt-test",
                )
            val result =
                runNewThreadOpenFlow(
                    thread = started,
                    normalizedCwd = "/repo",
                    sink = sink,
                )

            assertEquals(started, result)
            assertEquals(
                listOf(
                    "publish:thread-1",
                    "resume:thread-1:/repo:gpt-test",
                    "sync:thread-1",
                    "activate:thread-1",
                ),
                sink.events,
            )
        }

    @Test
    fun backendFlow_emptyRolloutActivatesButDoesNotRequireResumeForEmptyNewThread() =
        runTest {
            val sink =
                RecordingNewThreadOpenSink(
                    resumeFailure =
                        AgentServiceError.RpcFailure(
                            RPCError(
                                code = -32603,
                                message =
                                    "failed to read thread: thread-store internal error: " +
                                        "failed to read thread at C:\\Users\\andre\\.codex\\sessions\\rollout.jsonl: " +
                                        "rollout at C:\\Users\\andre\\.codex\\sessions\\rollout.jsonl is empty",
                                data = null,
                            ),
                        ),
                )

            val started =
                CodexThread(
                    id = "thread-1",
                    cwd = "/repo",
                    model = "gpt-test",
                )
            val result =
                runNewThreadOpenFlow(
                    thread = started,
                    normalizedCwd = "/repo",
                    sink = sink,
                )

            assertEquals(started, result)
            assertEquals(
                listOf(
                    "publish:thread-1",
                    "resume:thread-1:/repo:gpt-test",
                    "sync:thread-1",
                    "activate:thread-1",
                ),
                sink.events,
            )
        }

    @Test
    fun uiFlow_branchPickerRequestConsumptionIsOnlyAfterUserAction() {
        assertFalse(shouldConsumeBranchPickerOpenRequest(BranchPickerCloseCause.StateInvalidated))
        assertTrue(shouldConsumeBranchPickerOpenRequest(BranchPickerCloseCause.UserDismissed))
        assertTrue(shouldConsumeBranchPickerOpenRequest(BranchPickerCloseCause.BranchSelected))
        assertTrue(shouldConsumeBranchPickerOpenRequest(BranchPickerCloseCause.BranchCreated))
    }
}

private class RecordingNewThreadOpenSink(
    private val resumedThread: CodexThread? = null,
    private val resumeFailure: Throwable? = null,
) : NewThreadOpenFlowSink {
    val events = mutableListOf<String>()

    override suspend fun publishStartedThread(thread: CodexThread) {
        events += "publish:${thread.id}"
    }

    override suspend fun forceResumeStartedThread(
        thread: CodexThread,
        normalizedCwd: String?,
    ): CodexThread? {
        events += "resume:${thread.id}:$normalizedCwd:${thread.model}"
        resumeFailure?.let { throw it }
        return resumedThread
    }

    override suspend fun syncStartedThreadHistory(threadId: String) {
        events += "sync:$threadId"
    }

    override fun activateStartedThread(threadId: String) {
        events += "activate:$threadId"
    }
}
