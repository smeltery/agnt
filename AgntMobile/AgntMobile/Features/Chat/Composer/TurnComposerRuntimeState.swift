// FILE: TurnComposerRuntimeState.swift
// Purpose: Bundles the composer runtime selection state shared by the bottom bar and input context menu.
// Layer: View Helper
// Exports: TurnComposerRuntimeState
// Depends on: CodexService, TurnComposerMetaMapper, CodexServiceTier

import Foundation

struct TurnComposerRuntimeState: Equatable {
    let reasoningDisplayOptions: [TurnComposerReasoningDisplayOption]
    let effectiveReasoningEffort: String?
    let selectedReasoningEffort: String?
    let reasoningMenuDisabled: Bool
    let selectedServiceTier: CodexServiceTier?
    let supportsFastMode: Bool
    var serviceTiers: [CodexServiceTier] = [.fast]
    var serviceTierIsInherited = false

    var selectedReasoningTitle: String {
        effectiveReasoningEffort.map(TurnComposerMetaMapper.reasoningTitle(for:)) ?? "Select reasoning"
    }

    var showsSpeedBadgeInModelMenu: Bool {
        supportsFastMode && selectedServiceTier != nil
    }

    func isSelectedReasoning(_ effort: String) -> Bool {
        (selectedReasoningEffort ?? effectiveReasoningEffort) == effort
    }

    func isSelectedServiceTier(_ serviceTier: CodexServiceTier?) -> Bool {
        !serviceTierIsInherited && selectedServiceTier == serviceTier
    }

    static func resolve(
        codex: CodexService,
        reasoningDisplayOptions: [TurnComposerReasoningDisplayOption]
    ) -> TurnComposerRuntimeState {
        return TurnComposerRuntimeState(
            reasoningDisplayOptions: reasoningDisplayOptions,
            effectiveReasoningEffort: codex.selectedReasoningEffortForSelectedModel(threadId: codex.activeThreadId),
            selectedReasoningEffort: codex.selectedReasoningEffortForSelectedModel(threadId: codex.activeThreadId),
            reasoningMenuDisabled: reasoningDisplayOptions.isEmpty || codex.selectedModelOption(threadId: codex.activeThreadId) == nil,
            selectedServiceTier: codex.effectiveServiceTier(for: codex.activeThreadId),
            supportsFastMode: codex.selectedModelOption(threadId: codex.activeThreadId)?.supportsServiceTier(.fast) == true,
            serviceTiers: codex.selectedModelOption(threadId: codex.activeThreadId)?.serviceTiers ?? [],
            serviceTierIsInherited: codex.inheritsOwnerServiceTier(for: codex.activeThreadId)
        )
    }
}
