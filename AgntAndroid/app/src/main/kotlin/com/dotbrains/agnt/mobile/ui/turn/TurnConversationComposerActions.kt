package com.dotbrains.agnt.mobile.ui.turn

import com.dotbrains.agnt.mobile.core.model.CodexCollaborationModeKind
import com.dotbrains.agnt.mobile.core.model.CodexFileAttachment
import com.dotbrains.agnt.mobile.core.model.CodexImageAttachment
import com.dotbrains.agnt.mobile.core.model.CodexReviewTarget
import com.dotbrains.agnt.mobile.core.model.CodexTurnMention
import com.dotbrains.agnt.mobile.core.model.CodexTurnSkillMention
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.ui.turn.attachments.TurnComposerAttachment
import com.dotbrains.agnt.mobile.ui.turn.attachments.appendFileAttachmentsToDraft
import com.dotbrains.agnt.mobile.ui.turn.autocomplete.TurnComposerAutocompleteItem
import com.dotbrains.agnt.mobile.ui.turn.composer.ComposerMentionChipPayload
import com.dotbrains.agnt.mobile.ui.turn.composer.ComposerMentionKind
import com.dotbrains.agnt.mobile.ui.turn.composer.TrailingComposerMentionParse
import com.dotbrains.agnt.mobile.ui.turn.composer.TurnComposerTrailingTokens
import com.dotbrains.agnt.mobile.ui.turn.composer.formatTurnSendError
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

internal fun handleTurnComposerAutocompleteSelection(
    item: TurnComposerAutocompleteItem,
    draft: String,
    trailingToken: TrailingComposerMentionParse?,
    mentionChips: List<ComposerMentionChipPayload>,
    defaultReviewBaseBranch: String?,
    reviewNoDefaultBranchMessage: String,
    selectReviewTarget: (CodexReviewTarget, String?) -> Unit,
    setDraft: (String) -> Unit,
    setMentionChips: (List<ComposerMentionChipPayload>) -> Unit,
    setShowForkThreadSheet: (Boolean) -> Unit,
    setShowFeedbackDialog: (Boolean) -> Unit,
    setLastError: (String?) -> Unit,
) {
    val replaced =
        TurnComposerTrailingTokens.replaceTrailingSegment(
            text = draft,
            replacement = item.replacementText,
            parse = trailingToken,
        )
    setDraft(replaced.text)
    when (item.payload.kind) {
        ComposerMentionKind.File,
        ComposerMentionKind.Skill,
        ComposerMentionKind.Plugin,
        -> {
            if (mentionChips.none { it.kind == item.payload.kind && it.semanticValue == item.payload.semanticValue }) {
                setMentionChips(mentionChips + item.payload)
            }
        }
        ComposerMentionKind.SlashCommand -> {
            when {
                item.payload.semanticValue.equals("fork", ignoreCase = true) -> {
                    setDraft(replaced.text.removeSuffix("/fork ").trimEnd())
                    setShowForkThreadSheet(true)
                    setLastError(null)
                }
                item.payload.semanticValue.equals("feedback", ignoreCase = true) -> {
                    setDraft(replaced.text.removeSuffix("/feedback ").trimEnd())
                    setShowFeedbackDialog(true)
                    setLastError(null)
                }
                item.payload.semanticValue.equals("compact", ignoreCase = true) -> {
                    setDraft((replaced.text.trimEnd() + " /compact").trim())
                    setMentionChips(
                        mentionChips.filterNot { chip ->
                            chip.kind == ComposerMentionKind.SlashCommand &&
                                chip.semanticValue.equals("compact", ignoreCase = true)
                        },
                    )
                    setLastError(null)
                }
                item.payload.semanticValue.equals("review", ignoreCase = true) -> {
                    selectReviewTarget(CodexReviewTarget.uncommittedChanges, null)
                }
                item.payload.semanticValue.equals("review-base", ignoreCase = true) -> {
                    val branch = defaultReviewBaseBranch
                    if (branch == null) {
                        setDraft(replaced.text.removeSuffix("/review-base ").trimEnd())
                        setLastError(reviewNoDefaultBranchMessage)
                    } else {
                        selectReviewTarget(CodexReviewTarget.baseBranch, branch)
                    }
                }
            }
        }
    }
}

internal fun handleTurnComposerSend(
    threadId: String,
    repository: CodexRepository,
    scope: CoroutineScope,
    reviewTarget: CodexReviewTarget?,
    resolvedReviewBaseBranch: String?,
    isThreadRunning: Boolean,
    composerAttachments: List<TurnComposerAttachment>,
    draftWithMentions: String,
    readyComposerImageAttachments: List<CodexImageAttachment>,
    readyComposerFileAttachments: List<CodexFileAttachment>,
    structuredSkillMentions: List<CodexTurnSkillMention>,
    structuredFileMentions: List<CodexTurnMention>,
    isPlanModeEnabled: Boolean,
    attachmentFileBinarySummary: String,
    reviewRunningUnavailableMessage: String,
    reviewNoBaseBranchAvailableMessage: String,
    reviewNoAttachmentsMessage: String,
    cancelVoiceWork: () -> Unit,
    clearReviewTarget: () -> Unit,
    setSending: (Boolean) -> Unit,
    setDraft: (String) -> Unit,
    setMentionChips: (List<ComposerMentionChipPayload>) -> Unit,
    setLastError: (String?) -> Unit,
    dispatchTurn: (
        text: String,
        attachments: List<CodexImageAttachment>,
        skillMentions: List<CodexTurnSkillMention>,
        fileMentions: List<CodexTurnMention>,
        collaborationMode: CodexCollaborationModeKind?,
        fromQueue: Boolean,
    ) -> Unit,
) {
    cancelVoiceWork()
    setLastError(null)
    if (reviewTarget != null) {
        if (isThreadRunning) {
            setLastError(reviewRunningUnavailableMessage)
            return
        }
        if (reviewTarget.name == "baseBranch" && resolvedReviewBaseBranch == null) {
            setLastError(reviewNoBaseBranchAvailableMessage)
            return
        }
        if (composerAttachments.isNotEmpty()) {
            setLastError(reviewNoAttachmentsMessage)
            return
        }
        setSending(true)
        scope.launch {
            runCatching {
                repository.startReview(
                    threadId = threadId,
                    target = reviewTarget,
                    baseBranch = resolvedReviewBaseBranch,
                )
            }.onSuccess {
                setSending(false)
                setDraft("")
                setMentionChips(emptyList())
                clearReviewTarget()
            }.onFailure { e ->
                setSending(false)
                setLastError(formatTurnSendError(e))
            }
        }
        return
    }
    val draftText =
        appendFileAttachmentsToDraft(
            baseText = draftWithMentions,
            files = readyComposerFileAttachments,
            binarySummary = attachmentFileBinarySummary,
        )
    dispatchTurn(
        draftText,
        readyComposerImageAttachments,
        structuredSkillMentions,
        structuredFileMentions,
        if (isPlanModeEnabled) CodexCollaborationModeKind.plan else null,
        false,
    )
}
