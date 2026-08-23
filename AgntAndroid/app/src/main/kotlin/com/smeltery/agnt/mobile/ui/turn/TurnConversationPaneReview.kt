package com.smeltery.agnt.mobile.ui.turn

import com.smeltery.agnt.mobile.core.model.CodexReviewTarget
import com.smeltery.agnt.mobile.data.GitBranchDisplaySummary
import com.smeltery.agnt.mobile.ui.turn.attachments.TurnComposerAttachment
import com.smeltery.agnt.mobile.ui.turn.attachments.TurnComposerAttachmentState
import com.smeltery.agnt.mobile.ui.turn.composer.ComposerMentionChipPayload
import com.smeltery.agnt.mobile.ui.turn.composer.TurnComposerReviewModeRules
import com.smeltery.agnt.mobile.ui.turn.toolbar.resolveReviewBaseBranch

internal fun selectTurnReviewTarget(
    target: CodexReviewTarget,
    baseBranch: String?,
    draft: String,
    mentionChips: List<ComposerMentionChipPayload>,
    composerAttachments: List<TurnComposerAttachment>,
    isPlanModeEnabled: Boolean,
    defaultReviewBaseBranch: String?,
    loadedGitBranchSummary: GitBranchDisplaySummary?,
    reviewNoAttachmentsMessage: String,
    reviewRequiresEmptyMessage: String,
    setReviewTargetName: (String?) -> Unit,
    setReviewBaseBranch: (String?) -> Unit,
    setDraft: (String) -> Unit,
    setMentionChips: (List<ComposerMentionChipPayload>) -> Unit,
    setPlanModeEnabled: (Boolean) -> Unit,
    setLastError: (String?) -> Unit,
) {
    if (
        TurnComposerReviewModeRules.hasComposerContentConflictingWithReview(
            draftText = draft,
            mentionChipCount = mentionChips.size,
            readyAttachmentCount =
                composerAttachments.count {
                    it.state is TurnComposerAttachmentState.ReadyImage ||
                        it.state is TurnComposerAttachmentState.ReadyFile
                },
            hasBlockingAttachments =
                composerAttachments.any {
                    it.state == TurnComposerAttachmentState.Loading ||
                        it.state is TurnComposerAttachmentState.Failed
                },
            isPlanModeEnabled = isPlanModeEnabled,
        )
    ) {
        setLastError(if (composerAttachments.isNotEmpty()) reviewNoAttachmentsMessage else reviewRequiresEmptyMessage)
        return
    }
    val resolvedBaseBranch =
        resolveReviewBaseBranch(
            selectedBaseBranch = baseBranch,
            defaultBranch = defaultReviewBaseBranch,
            availableBranches = loadedGitBranchSummary?.branches.orEmpty(),
        )
    setReviewTargetName(target.name)
    setReviewBaseBranch(resolvedBaseBranch)
    setDraft(turnReviewDraftText(target, resolvedBaseBranch))
    setMentionChips(emptyList())
    setPlanModeEnabled(false)
    setLastError(null)
}

internal fun turnReviewDraftText(
    target: CodexReviewTarget,
    baseBranch: String?,
): String =
    when (target) {
        CodexReviewTarget.uncommittedChanges -> "Review current changes"
        CodexReviewTarget.baseBranch -> "Review against base branch ${baseBranch.orEmpty()}"
    }

internal fun applyTurnPlanToComposer(
    hasComposerDraftContent: Boolean,
    planApplyRequiresEmptyMessage: String,
    setDraft: (String) -> Unit,
    setPlanModeEnabled: (Boolean) -> Unit,
    setMentionChips: (List<ComposerMentionChipPayload>) -> Unit,
    setLastError: (String?) -> Unit,
) {
    if (hasComposerDraftContent) {
        setLastError(planApplyRequiresEmptyMessage)
    } else {
        setDraft("Implement plan.")
        setPlanModeEnabled(false)
        setMentionChips(emptyList())
    }
}
