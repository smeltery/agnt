// FILE: TurnComposerRuntimeActions.swift
// Purpose: Centralizes the composer runtime selection callbacks shared across nested views.
// Layer: View Helper
// Exports: TurnComposerRuntimeActions
// Depends on: CodexService, CodexServiceTier

import Foundation

struct TurnComposerRuntimeActions {
    let selectModel: (String) -> Void
    let selectAutomaticReasoning: () -> Void
    let selectReasoning: (String) -> Void
    let selectServiceTier: (CodexServiceTier?) -> Void

    static func resolve(codex: CodexService) -> TurnComposerRuntimeActions {
        let threadId = codex.activeThreadId
        let synchronizes = codex.runtimeSettingsProviderId == "codex" && threadId != nil
        return TurnComposerRuntimeActions(
            selectModel: { model in
                if synchronizes, let threadId { codex.setThreadModelOverride(model, for: threadId) }
                else { codex.setSelectedModelId(model) }
            },
            selectAutomaticReasoning: {
                if synchronizes { codex.clearThreadReasoningEffortOverride(for: threadId) }
                else { codex.setSelectedReasoningEffort(nil) }
            },
            selectReasoning: { effort in
                if synchronizes { codex.setThreadReasoningEffortOverride(effort, for: threadId) }
                else { codex.setSelectedReasoningEffort(effort) }
            },
            selectServiceTier: { tier in
                if synchronizes { codex.setThreadServiceTierOverride(tier, for: threadId) }
                else { codex.setSelectedServiceTier(tier) }
            }
        )
    }
}
