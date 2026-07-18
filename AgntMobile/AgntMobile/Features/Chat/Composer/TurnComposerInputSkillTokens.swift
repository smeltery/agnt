// FILE: TurnComposerInputSkillTokens.swift
// Purpose: Keeps inline skill-token refresh logic out of the composer text-view wrapper.
// Layer: View Support
// Exports: TurnComposerInputTextView.Coordinator skill-token helpers
// Depends on: UIKit, TurnComposerInlineSkillToken

import UIKit

extension TurnComposerInputTextView.Coordinator {
    func updateMentionedSkillNames(_ names: [String]) {
        mentionedSkillNames = names
    }

    func shouldRefreshInlineSkillTokens(
        mentionNames: [String],
        font: UIFont,
        in textView: UITextView
    ) -> Bool {
        if mentionNames != mentionedSkillNames {
            return true
        }
        let currentFont = textView.typingAttributes[.font] as? UIFont
        if currentFont?.fontName != font.fontName || abs((currentFont?.pointSize ?? 0) - font.pointSize) > 0.5 {
            return true
        }
        return TurnComposerInlineSkillToken.normalizeTokenAttributes(in: textView.textStorage)
    }
}
