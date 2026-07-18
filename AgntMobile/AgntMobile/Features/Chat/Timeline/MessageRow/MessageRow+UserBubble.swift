// FILE: MessageRow+UserBubble.swift
// Purpose: User-message rendering helpers for MessageRow.
// Layer: View Components

import SwiftUI
import UIKit

extension MessageRow {
    func userBubble(text: String) -> some View {
        let renderModel = UserBubbleRenderModelCache.model(for: message, text: text)
        return HStack {
            Spacer(minLength: 60)
            VStack(alignment: .trailing, spacing: 4) {
                if !message.attachments.isEmpty {
                    UserAttachmentStrip(attachments: message.attachments) { tappedAttachment in
                        if let image = AttachmentPreviewImageResolver.resolve(tappedAttachment) {
                            previewImage = PreviewImagePayload(image: image)
                        }
                    }
                }

                if !renderModel.chips.isEmpty {
                    UserMentionChipStrip(chips: renderModel.chips)
                }

                if !renderModel.text.isEmpty {
                    UserBubbleTextBlock(
                        contentIdentity: message.id,
                        rawText: renderModel.text,
                        contentResetKey: renderModel.textFingerprint,
                        collapsesWithLineLimit: !renderModel.usesBlockMarkdown
                    ) { isCollapsed in
                        userBubbleText(renderModel, isCollapsed: isCollapsed)
                            .font(AppFont.body())
                    }
                        .padding(.vertical, 12)
                        .padding(.horizontal, 16)
                        .background {
                            RoundedRectangle(cornerRadius: 22, style: .continuous)
                                .fill(Color(.tertiarySystemFill).opacity(0.8))
                        }
                }

                if let statusText = deliveryStatusText {
                    Text(statusText)
                        .font(AppFont.caption2())
                        .foregroundStyle(message.deliveryState == .failed ? .red : .secondary)
                }
            }
            .contextMenu {
                if message.role == .user, !text.isEmpty {
                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        UIPasteboard.general.string = text
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                }
                if isRetryAvailable, message.role == .user, !text.isEmpty {
                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        onRetryUserMessage(text)
                    } label: {
                        Label("Retry", systemImage: "arrow.clockwise")
                    }
                }
            }
        }
        .fullScreenCover(item: $previewImage) { payload in
            ZoomableImagePreviewScreen(
                payload: payload,
                onDismiss: { previewImage = nil }
            )
        }
        .modifier(UserBubbleSendAppearance(isEnabled: isFreshLocalSend))
    }

    private var isFreshLocalSend: Bool {
        message.deliveryState == .pending
            && Date().timeIntervalSince(message.createdAt) < 3
    }

    @ViewBuilder
    private func userBubbleText(_ renderModel: UserBubbleRenderModel, isCollapsed: Bool) -> some View {
        if renderModel.usesBlockMarkdown {
            MarkdownTextView(
                text: isCollapsed
                    ? UserBubbleCollapsedMarkdownPreview.previewText(for: renderModel.text)
                    : renderModel.text,
                profile: .userProse,
                constrainsToAvailableWidth: true
            )
            .foregroundStyle(.primary)
            .tint(.primary)
        } else if renderModel.text.contains("@") || renderModel.text.contains("$") {
            userBubbleMentionText(renderModel.text)
        } else {
            UserBubbleInlineMarkdownText(renderModel.text, foreground: .primary)
        }
    }

    // Renders inline @file/plugin and $skill mentions inside one AttributedString so large
    // messages do not build an arbitrarily deep SwiftUI Text concatenation chain.
    private func userBubbleMentionText(_ normalizedRawText: String) -> Text {
        let confirmedFileMentions = Set(
            message.fileMentions
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .map(TurnMessageRegexCache.removingTrailingLineColumnSuffix)
                .filter { !$0.isEmpty }
        )

        guard let mentionRegex = TurnMessageRegexCache.userMentionToken else {
            return Text(normalizedRawText)
        }

        let nsText = normalizedRawText as NSString
        let fullRange = NSRange(location: 0, length: nsText.length)
        let matches = mentionRegex.matches(in: normalizedRawText, range: fullRange)
        guard !matches.isEmpty else {
            return Text(normalizedRawText)
        }

        return Text(
            userBubbleAttributedText(
                from: normalizedRawText,
                matches: matches,
                nsText: nsText,
                confirmedFileMentions: confirmedFileMentions
            )
        )
    }

    private func normalizedMentionToken(_ token: String) -> (token: String, trailingPunctuation: String) {
        let punctuationSet = CharacterSet(charactersIn: ".,;:!?)]}")
        let scalars = Array(token.unicodeScalars)

        var splitIndex = scalars.count
        while splitIndex > 0, punctuationSet.contains(scalars[splitIndex - 1]) {
            splitIndex -= 1
        }

        let pathScalars = scalars.prefix(splitIndex)
        let trailingScalars = scalars.suffix(scalars.count - splitIndex)
        let path = String(String.UnicodeScalarView(pathScalars))
        let trailing = String(String.UnicodeScalarView(trailingScalars))
        return (path, trailing)
    }

    // Keeps long mention-heavy prompts renderable without hitting SwiftUI's recursive
    // ConcatenatedTextStorage resolution path.
    private func userBubbleAttributedText(
        from text: String,
        matches: [NSTextCheckingResult],
        nsText: NSString,
        confirmedFileMentions: Set<String>
    ) -> AttributedString {
        var attributed = AttributedString()
        var cursor = 0

        for match in matches {
            let matchRange = match.range
            let triggerRange = match.range(at: 1)
            let tokenRange = match.range(at: 2)
            guard triggerRange.location != NSNotFound,
                  tokenRange.location != NSNotFound else {
                continue
            }

            if matchRange.location > cursor {
                let plain = nsText.substring(with: NSRange(location: cursor, length: matchRange.location - cursor))
                if !plain.isEmpty {
                    attributed.append(AttributedString(plain))
                }
            }

            let trigger = nsText.substring(with: triggerRange)
            let rawToken = nsText.substring(with: tokenRange)
            let (normalizedToken, trailingPunctuation) = normalizedMentionToken(rawToken)
            let fullMatch = nsText.substring(with: matchRange)
            let normalizedConfirmedToken = TurnMessageRegexCache.removingTrailingLineColumnSuffix(from: normalizedToken)
            let isConfirmedFileMention = confirmedFileMentions.contains(normalizedConfirmedToken)
            let isPluginMention = trigger == "@" && isLikelyPluginMention(normalizedToken)
            if trigger == "@", !isConfirmedFileMention, !isPluginMention {
                attributed.append(AttributedString(fullMatch))
                cursor = matchRange.location + matchRange.length
                continue
            }

            if !normalizedToken.isEmpty {
                let displayName: String
                let color: Color

                if trigger == "@", isConfirmedFileMention {
                    displayName = normalizedToken.pathDisplayName
                    color = .blue
                } else if trigger == "@" {
                    displayName = SkillDisplayNameFormatter.displayName(for: normalizedToken)
                    color = .blue
                } else {
                    displayName = SkillDisplayNameFormatter.displayName(for: normalizedToken)
                    color = .indigo
                }

                var highlightedSegment = AttributedString(displayName)
                highlightedSegment.foregroundColor = color
                attributed.append(highlightedSegment)
            }

            if !trailingPunctuation.isEmpty {
                attributed.append(AttributedString(trailingPunctuation))
            }

            cursor = matchRange.location + matchRange.length
        }

        if cursor < nsText.length {
            attributed.append(AttributedString(nsText.substring(from: cursor)))
        }

        if attributed.characters.isEmpty {
            return AttributedString(text)
        }

        return attributed
    }

    // Keeps plugin coloring to app-style slugs so Swift attributes and scoped build labels stay plain.
    private func isLikelyPluginMention(_ token: String) -> Bool {
        let normalized = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = normalized.first,
              first.isLowercase || first.isNumber else {
            return false
        }

        return normalized.allSatisfy { character in
            character.isLetter || character.isNumber || character == "-" || character == "_"
        }
    }
}
