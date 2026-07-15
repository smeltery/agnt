package com.dotbrains.agnt.mobile.ui.shell

import com.dotbrains.agnt.mobile.core.model.TurnGitSyncAlert
import com.dotbrains.agnt.mobile.core.model.TurnGitSyncAlertAction
import com.dotbrains.agnt.mobile.services.git.GitActionsError
import com.dotbrains.agnt.mobile.ui.home.GitActionProgressPhase
import kotlinx.coroutines.TimeoutCancellationException

internal fun handleMainShellGitActionFailure(
    error: Throwable,
    setProgressMessage: (String?) -> Unit,
    setProgressPhase: (GitActionProgressPhase?) -> Unit,
    resetProgressIncludes: () -> Unit,
    onNothingToCommit: () -> Unit,
    setGitSyncAlert: (TurnGitSyncAlert?) -> Unit,
    clearPendingGitOperation: () -> Unit,
    setGitActionError: (String?) -> Unit,
) {
    setProgressMessage(null)
    setProgressPhase(null)
    resetProgressIncludes()
    when {
        error is GitActionsError.BridgeFailure && error.errorCode == "nothing_to_commit" -> onNothingToCommit()
        error is GitActionsError.BridgeFailure && (error.errorCode == "branch_is_main" || error.errorCode == "protected_branch") -> {
            setGitSyncAlert(
                TurnGitSyncAlert.withDefaultButtons(
                    title = "Protected branch",
                    message = error.message?.ifBlank { null } ?: "This branch is protected.",
                    action = TurnGitSyncAlertAction.dismissOnly,
                ),
            )
            clearPendingGitOperation()
        }
        error is TimeoutCancellationException -> setGitActionError("Git operation timed out. Check the desktop bridge and try again.")
        else -> setGitActionError(error.message?.ifBlank { null } ?: error.toString())
    }
}
