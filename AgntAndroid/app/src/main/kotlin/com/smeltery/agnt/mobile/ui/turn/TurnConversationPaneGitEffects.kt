package com.smeltery.agnt.mobile.ui.turn

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import com.smeltery.agnt.mobile.core.transport.ConnectionState
import com.smeltery.agnt.mobile.data.CodexRepository
import com.smeltery.agnt.mobile.data.GitBranchDisplayMapper
import com.smeltery.agnt.mobile.data.loadGitBranchesWithStatus
import com.smeltery.agnt.mobile.ui.turn.toolbar.GitBranchPaneState

@Composable
internal fun TurnConversationPaneGitBranchEffect(
    threadId: String,
    gitCwd: String?,
    connectionState: ConnectionState,
    ready: Boolean,
    gitBranchReloadNonce: Int,
    repository: CodexRepository,
    setGitBranchPaneState: (GitBranchPaneState) -> Unit,
) {
    LaunchedEffect(threadId, gitCwd, connectionState, ready, gitBranchReloadNonce) {
        when {
            gitCwd == null -> {
                setGitBranchPaneState(GitBranchPaneState.UnavailableNoProject)
                return@LaunchedEffect
            }
            connectionState !is ConnectionState.Connected -> {
                setGitBranchPaneState(GitBranchPaneState.AwaitingBridge)
                return@LaunchedEffect
            }
            !ready -> {
                setGitBranchPaneState(GitBranchPaneState.Loading)
                return@LaunchedEffect
            }
            else -> {
                setGitBranchPaneState(GitBranchPaneState.Loading)
                val result = loadGitBranchesWithStatus(repository, gitCwd)
                setGitBranchPaneState(
                    result.fold(
                        onSuccess = {
                            GitBranchPaneState.Loaded(GitBranchDisplayMapper.summaryFrom(it))
                        },
                        onFailure = {
                            GitBranchPaneState.Failed(GitBranchDisplayMapper.userVisibleMessage(it))
                        },
                    ),
                )
            }
        }
    }
}
