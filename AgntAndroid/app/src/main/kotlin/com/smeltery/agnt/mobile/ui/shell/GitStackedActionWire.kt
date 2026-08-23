package com.smeltery.agnt.mobile.ui.shell

import com.smeltery.agnt.mobile.ui.shell.GitActionNextStep

internal fun GitActionNextStep.toStackedWireAction(): String =
    when (this) {
        GitActionNextStep.commit -> "commit"
        GitActionNextStep.push -> "push"
        GitActionNextStep.commitAndPush -> "commit_push"
        GitActionNextStep.commitPushAndPullRequest -> "commit_push_pr"
        GitActionNextStep.pushAndPullRequest,
        GitActionNextStep.createPullRequest,
        -> "create_pr"
    }

internal fun GitActionNextStep.involvesNativePullRequest(): Boolean =
    when (this) {
        GitActionNextStep.commitPushAndPullRequest,
        GitActionNextStep.pushAndPullRequest,
        GitActionNextStep.createPullRequest,
        -> true
        else -> false
    }

internal fun GitActionNextStep.involvesCommit(): Boolean =
    when (this) {
        GitActionNextStep.commit,
        GitActionNextStep.commitAndPush,
        GitActionNextStep.commitPushAndPullRequest,
        -> true
        else -> false
    }
