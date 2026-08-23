package com.smeltery.agnt.mobile.ui.turn.composer

import com.smeltery.agnt.mobile.core.error.AgentServiceError
import com.smeltery.agnt.mobile.core.model.CodexAccessMode
import com.smeltery.agnt.mobile.core.model.CodexModelOption
import com.smeltery.agnt.mobile.core.model.CodexServiceTier

internal data class ReasoningEffortTitleStrings(
    val low: String,
    val medium: String,
    val high: String,
    val xhigh: String,
)

private fun reasoningEffortMenuLabel(
    effortId: String,
    titles: ReasoningEffortTitleStrings,
    bridgeDescription: String,
): Pair<String, String?> {
    val key =
        effortId
            .trim()
            .lowercase()
            .replace('-', '_')
            .replace(' ', '_')
    val desc = bridgeDescription.trim()
    val knownTitle =
        when (key) {
            "low" -> titles.low
            "medium" -> titles.medium
            "high" -> titles.high
            "xhigh", "extra_high" -> titles.xhigh
            else -> null
        }
    return if (knownTitle != null) {
        knownTitle to desc.takeIf { it.isNotEmpty() }
    } else {
        val label =
            desc.ifBlank {
                effortId.replaceFirstChar { it.uppercaseChar() }
            }
        label to null
    }
}

internal fun buildRuntimeControlsState(
    models: List<CodexModelOption>,
    isLoadingModels: Boolean,
    selectedModelId: String?,
    selectedReasoningEffort: String?,
    selectedAccessMode: CodexAccessMode,
    selectedServiceTier: CodexServiceTier?,
    loadingLabel: String,
    modelFallbackLabel: String,
    noModelsLabel: String,
    autoLabel: String,
    normalTierLabel: String,
    reasoningEffortTitles: ReasoningEffortTitleStrings,
): TurnComposerRuntimeControlsState {
    val selectedModel =
        selectedModelId?.let { id -> models.firstOrNull { it.id == id || it.model == id } }
            ?: models.firstOrNull { it.isDefault }
            ?: models.firstOrNull()
    val modelOptions =
        models.map {
            TurnComposerRuntimeOption(
                id = it.id,
                label = it.displayName.ifBlank { it.model.ifBlank { it.id } },
                detail = it.description.takeIf { desc -> desc.isNotBlank() },
            )
        }
    val modelState =
        TurnComposerRuntimeSelectorState(
            selected =
                selectedModel?.let {
                    TurnComposerRuntimeOption(
                        id = it.id,
                        label = it.displayName.ifBlank { it.model.ifBlank { it.id } },
                        detail = it.description.takeIf { desc -> desc.isNotBlank() },
                    )
                } ?: TurnComposerRuntimeOption(
                    id = TURN_COMPOSER_RUNTIME_AUTO_ID,
                    label = if (isLoadingModels) loadingLabel else modelFallbackLabel,
                    enabled = false,
                ),
            options =
                modelOptions.ifEmpty {
                    listOf(
                        TurnComposerRuntimeOption(TURN_COMPOSER_RUNTIME_AUTO_ID, noModelsLabel, enabled = false),
                    )
                },
            enabled = modelOptions.isNotEmpty() && !isLoadingModels,
        )

    val reasoningOptions =
        selectedModel?.supportedReasoningEfforts.orEmpty().map {
            val (label, detail) =
                reasoningEffortMenuLabel(it.reasoningEffort, reasoningEffortTitles, it.description)
            TurnComposerRuntimeOption(
                id = it.reasoningEffort,
                label = label,
                detail = detail,
            )
        }
    val effectiveReasoning =
        selectedReasoningEffort?.takeIf { selected -> reasoningOptions.any { it.id == selected } }
            ?: selectedModel?.defaultReasoningEffort?.takeIf { default -> reasoningOptions.any { it.id == default } }
            ?: reasoningOptions.firstOrNull()?.id
    val reasoningState =
        TurnComposerRuntimeSelectorState(
            selected =
                reasoningOptions.firstOrNull { it.id == effectiveReasoning }
                    ?: TurnComposerRuntimeOption(TURN_COMPOSER_RUNTIME_AUTO_ID, autoLabel, enabled = false),
            options =
                listOf(TurnComposerRuntimeOption(TURN_COMPOSER_RUNTIME_AUTO_ID, autoLabel)) + reasoningOptions,
            enabled = reasoningOptions.isNotEmpty(),
        )

    val accessOptions =
        CodexAccessMode.entries.map {
            TurnComposerRuntimeOption(
                id = it.name,
                label = it.displayName,
                detail = it.menuTitle,
            )
        }
    val serviceTierOptions =
        listOf(TurnComposerRuntimeOption(TURN_COMPOSER_RUNTIME_AUTO_ID, normalTierLabel)) +
            CodexServiceTier.entries.map {
                TurnComposerRuntimeOption(
                    id = it.name,
                    label = it.displayName,
                    detail = it.description,
                )
            }

    return TurnComposerRuntimeControlsState(
        model = modelState,
        reasoningEffort = reasoningState,
        accessMode =
            TurnComposerRuntimeSelectorState(
                selected = accessOptions.first { it.id == selectedAccessMode.name },
                options = accessOptions,
            ),
        serviceTier =
            TurnComposerRuntimeSelectorState(
                selected =
                    serviceTierOptions.firstOrNull { it.id == selectedServiceTier?.name }
                        ?: serviceTierOptions.first(),
                options = serviceTierOptions,
            ),
    )
}

internal fun formatTurnSendError(e: Throwable): String =
    when (e) {
        is AgentServiceError.ThreadRemovedOnServer -> e.message ?: ""
        is AgentServiceError.RpcFailure -> "${e.rpcError.code}: ${e.rpcError.message}"
        is AgentServiceError -> e.message ?: e.javaClass.simpleName
        else -> e.message ?: e.javaClass.simpleName
    }
