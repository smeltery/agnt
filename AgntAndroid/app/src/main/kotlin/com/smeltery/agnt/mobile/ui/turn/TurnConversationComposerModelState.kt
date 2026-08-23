package com.smeltery.agnt.mobile.ui.turn

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.res.stringResource
import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.core.model.CodexAccessMode
import com.smeltery.agnt.mobile.core.model.CodexFileAttachment
import com.smeltery.agnt.mobile.core.model.CodexImageAttachment
import com.smeltery.agnt.mobile.core.model.CodexModelOption
import com.smeltery.agnt.mobile.core.model.CodexServiceTier
import com.smeltery.agnt.mobile.core.model.CodexTurnMention
import com.smeltery.agnt.mobile.core.model.CodexTurnSkillMention
import com.smeltery.agnt.mobile.ui.turn.attachments.TurnComposerAttachment
import com.smeltery.agnt.mobile.ui.turn.attachments.TurnComposerAttachmentState
import com.smeltery.agnt.mobile.ui.turn.autocomplete.mentionChipsToFileMentions
import com.smeltery.agnt.mobile.ui.turn.autocomplete.mentionChipsToSkillMentions
import com.smeltery.agnt.mobile.ui.turn.autocomplete.mergeMentionChipsIntoDraft
import com.smeltery.agnt.mobile.ui.turn.composer.ComposerMentionChipPayload
import com.smeltery.agnt.mobile.ui.turn.composer.ReasoningEffortTitleStrings
import com.smeltery.agnt.mobile.ui.turn.composer.TurnComposerEvent
import com.smeltery.agnt.mobile.ui.turn.composer.TurnComposerModel
import com.smeltery.agnt.mobile.ui.turn.composer.TurnComposerReducer
import com.smeltery.agnt.mobile.ui.turn.composer.TurnComposerRuntimeControlsState
import com.smeltery.agnt.mobile.ui.turn.composer.TurnVoicePhase
import com.smeltery.agnt.mobile.ui.turn.composer.buildRuntimeControlsState

internal data class TurnConversationComposerModelState(
    val readyComposerImageAttachments: List<CodexImageAttachment>,
    val readyComposerFileAttachments: List<CodexFileAttachment>,
    val runtimeControls: TurnComposerRuntimeControlsState,
    val draftWithMentions: String,
    val structuredSkillMentions: List<CodexTurnSkillMention>,
    val structuredFileMentions: List<CodexTurnMention>,
    val composerModel: TurnComposerModel,
)

@Composable
internal fun rememberTurnConversationComposerModelState(
    availableModels: List<CodexModelOption>,
    isLoadingModels: Boolean,
    selectedModelId: String?,
    selectedReasoningEffort: String?,
    selectedAccessMode: CodexAccessMode,
    selectedServiceTier: CodexServiceTier?,
    draft: String,
    composerAttachments: List<TurnComposerAttachment>,
    mentionChips: List<ComposerMentionChipPayload>,
    voicePhase: TurnVoicePhase,
    isThreadRunning: Boolean,
    isTranscribing: Boolean,
    ready: Boolean,
    sending: Boolean,
): TurnConversationComposerModelState {
    val readyComposerImageAttachments =
        remember(composerAttachments) {
            composerAttachments.mapNotNull { attachment ->
                (attachment.state as? TurnComposerAttachmentState.ReadyImage)?.attachment
            }
        }
    val readyComposerFileAttachments =
        remember(composerAttachments) {
            composerAttachments.mapNotNull { attachment ->
                (attachment.state as? TurnComposerAttachmentState.ReadyFile)?.attachment
            }
        }
    val runtimeLoadingLabel = stringResource(R.string.turn_runtime_loading)
    val runtimeModelFallbackLabel = stringResource(R.string.turn_runtime_model_fallback)
    val runtimeNoModelsLabel = stringResource(R.string.turn_runtime_no_models)
    val runtimeAutoLabel = stringResource(R.string.turn_runtime_auto)
    val runtimeNormalLabel = stringResource(R.string.turn_runtime_normal)
    val reasoningEffortTitles =
        ReasoningEffortTitleStrings(
            low = stringResource(R.string.turn_runtime_reasoning_title_low),
            medium = stringResource(R.string.turn_runtime_reasoning_title_medium),
            high = stringResource(R.string.turn_runtime_reasoning_title_high),
            xhigh = stringResource(R.string.turn_runtime_reasoning_title_xhigh),
        )
    val runtimeControls =
        remember(
            availableModels,
            isLoadingModels,
            selectedModelId,
            selectedReasoningEffort,
            selectedAccessMode,
            selectedServiceTier,
            runtimeLoadingLabel,
            runtimeModelFallbackLabel,
            runtimeNoModelsLabel,
            runtimeAutoLabel,
            runtimeNormalLabel,
            reasoningEffortTitles,
        ) {
            buildRuntimeControlsState(
                models = availableModels,
                isLoadingModels = isLoadingModels,
                selectedModelId = selectedModelId,
                selectedReasoningEffort = selectedReasoningEffort,
                selectedAccessMode = selectedAccessMode,
                selectedServiceTier = selectedServiceTier,
                loadingLabel = runtimeLoadingLabel,
                modelFallbackLabel = runtimeModelFallbackLabel,
                noModelsLabel = runtimeNoModelsLabel,
                autoLabel = runtimeAutoLabel,
                normalTierLabel = runtimeNormalLabel,
                reasoningEffortTitles = reasoningEffortTitles,
            )
        }
    val draftWithMentions =
        remember(draft, mentionChips) {
            mergeMentionChipsIntoDraft(draft, mentionChips)
        }
    val structuredSkillMentions =
        remember(mentionChips) {
            mentionChipsToSkillMentions(mentionChips)
        }
    val structuredFileMentions =
        remember(mentionChips) {
            mentionChipsToFileMentions(mentionChips)
        }
    val composerModel =
        remember(
            ready,
            sending,
            draftWithMentions,
            composerAttachments,
            mentionChips,
            voicePhase,
            isThreadRunning,
            isTranscribing,
        ) {
            listOf<TurnComposerEvent>(
                TurnComposerEvent.SetEnabled(ready),
                TurnComposerEvent.SetSending(sending),
                TurnComposerEvent.SetDraftText(draftWithMentions),
                TurnComposerEvent.SetReadyAttachmentCount(
                    composerAttachments.count {
                        it.state is TurnComposerAttachmentState.ReadyImage ||
                            it.state is TurnComposerAttachmentState.ReadyFile
                    },
                ),
                TurnComposerEvent.SetHasBlockingAttachments(
                    composerAttachments.any {
                        it.state == TurnComposerAttachmentState.Loading ||
                            it.state is TurnComposerAttachmentState.Failed
                    },
                ),
                TurnComposerEvent.SetVoicePhase(voicePhase),
                TurnComposerEvent.SetThreadRunning(isThreadRunning),
                TurnComposerEvent.SetTranscribing(isTranscribing),
            ).fold(TurnComposerModel()) { state, evt ->
                TurnComposerReducer.reduce(state, evt)
            }
        }

    return TurnConversationComposerModelState(
        readyComposerImageAttachments = readyComposerImageAttachments,
        readyComposerFileAttachments = readyComposerFileAttachments,
        runtimeControls = runtimeControls,
        draftWithMentions = draftWithMentions,
        structuredSkillMentions = structuredSkillMentions,
        structuredFileMentions = structuredFileMentions,
        composerModel = composerModel,
    )
}
