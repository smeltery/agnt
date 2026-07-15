package com.dotbrains.agnt.mobile.ui.turn

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.dotbrains.agnt.mobile.R

internal data class TurnConversationPaneStrings(
    val undoMissingCwd: String,
    val undoFailed: String,
    val checkoutElsewhereBlocked: String,
    val attachmentLimit: String,
    val attachmentOverflow: String,
    val attachmentLoadFailed: String,
    val attachmentFileTooLarge: String,
    val attachmentFileBinarySummary: String,
    val attachmentCameraUnavailable: String,
    val attachmentCameraPermissionDenied: String,
    val voiceMicDenied: String,
    val voiceRecorderFailed: String,
    val voiceNoAudio: String,
    val voiceTranscriptionFailed: String,
    val queuedDraftSendFailed: String,
    val queuedDraftRestoreBlocked: String,
    val planApplyRequiresEmpty: String,
    val reviewRunningUnavailable: String,
    val reviewRequiresEmpty: String,
    val reviewNoDefaultBranch: String,
    val reviewNoBaseBranchAvailable: String,
    val reviewNoAttachments: String,
    val handoffMissingBase: String,
    val handoffMissingLocal: String,
)

@Composable
internal fun rememberTurnConversationPaneStrings(): TurnConversationPaneStrings =
    TurnConversationPaneStrings(
        undoMissingCwd = stringResource(R.string.turn_usage_revert_reason_missing_cwd),
        undoFailed = stringResource(R.string.turn_message_action_undo_failed),
        checkoutElsewhereBlocked = stringResource(R.string.git_branch_checkout_elsewhere_blocked),
        attachmentLimit = stringResource(R.string.turn_attachment_limit, MAX_COMPOSER_ATTACHMENTS),
        attachmentOverflow = stringResource(R.string.turn_attachment_overflow, MAX_COMPOSER_ATTACHMENTS),
        attachmentLoadFailed = stringResource(R.string.turn_attachment_load_failed),
        attachmentFileTooLarge = stringResource(R.string.turn_attachment_file_too_large, MAX_NON_IMAGE_ATTACHMENT_BYTES / 1024),
        attachmentFileBinarySummary = stringResource(R.string.turn_attachment_file_binary_summary),
        attachmentCameraUnavailable = stringResource(R.string.turn_attachment_camera_unavailable),
        attachmentCameraPermissionDenied = stringResource(R.string.turn_attachment_camera_permission_denied),
        voiceMicDenied = stringResource(R.string.turn_voice_mic_permission_denied),
        voiceRecorderFailed = stringResource(R.string.turn_voice_recorder_failed),
        voiceNoAudio = stringResource(R.string.turn_voice_no_audio),
        voiceTranscriptionFailed = stringResource(R.string.turn_voice_transcription_failed),
        queuedDraftSendFailed = stringResource(R.string.turn_queue_send_failed),
        queuedDraftRestoreBlocked = stringResource(R.string.turn_queue_restore_requires_empty),
        planApplyRequiresEmpty = stringResource(R.string.turn_plan_apply_requires_empty),
        reviewRunningUnavailable = stringResource(R.string.turn_review_unavailable_running),
        reviewRequiresEmpty = stringResource(R.string.turn_review_requires_empty),
        reviewNoDefaultBranch = stringResource(R.string.turn_review_no_default_branch),
        reviewNoBaseBranchAvailable = stringResource(R.string.turn_review_no_base_branch_available),
        reviewNoAttachments = stringResource(R.string.turn_review_no_attachments),
        handoffMissingBase = stringResource(R.string.turn_worktree_handoff_missing_base),
        handoffMissingLocal = stringResource(R.string.turn_worktree_handoff_missing_local),
    )
