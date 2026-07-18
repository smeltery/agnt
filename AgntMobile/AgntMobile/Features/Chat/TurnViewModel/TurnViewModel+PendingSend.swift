// FILE: TurnViewModel+PendingSend.swift
// Purpose: Captured composer payload used by send and queue recovery.
// Layer: View Model

import Foundation

extension TurnViewModel {
    // Preserves the exact composer payload + raw chips so stale-busy recovery can retry cleanly.
    struct PendingTurnSend {
        let payload: String
        let attachments: [CodexImageAttachment]
        let skillMentions: [CodexTurnSkillMention]
        let mentionMentions: [CodexTurnMention]
        let collaborationMode: CodexCollaborationModeKind?
        let rawInput: String
        let rawFileMentions: [TurnComposerMentionedFile]
        let rawSkillMentions: [TurnComposerMentionedSkill]
        let rawPluginMentions: [TurnComposerMentionedPlugin]
        let rawAttachments: [TurnComposerImageAttachment]
        let rawReviewSelection: TurnComposerReviewSelection?
        let rawSubagentsSelectionArmed: Bool
    }
}
