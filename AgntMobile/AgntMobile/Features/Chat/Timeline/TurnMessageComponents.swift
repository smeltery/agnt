// FILE: TurnMessageComponents.swift
// Purpose: SwiftUI views for rendering turn messages: MessageRow, ApprovalBanner, and subviews.
// Layer: View Components
// Exports: MessageRow, ApprovalBanner
// Depends on: SwiftUI, TurnMessageRegexCache, SkillReferenceFormatter,
//   ThinkingDisclosureParser, CodeCommentDirectiveParser, TurnFileChangeSummaryParser,
//   TurnMessageCaches, TurnMarkdownModels, TurnDiffRenderer, CommandExecutionViews

import SwiftUI
import UIKit

// Keep Textual selection out of the scrolling timeline. This is shared by both
// plain markdown rows and Mermaid-interleaved markdown segments.
let enablesInlineMarkdownSelectionInTimeline = false

// Normalizes streaming placeholders once so assistant rows do not render transient status text
// as if it were final message content.
func timelineDisplayText(for message: CodexMessage) -> String {
    let trimmedText = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
    if message.isStreaming {
        let placeholderTexts: Set<String> = [
            "...",
            "Applying file changes...",
            "Updating...",
            "Coordinating agents...",
            "Planning...",
            "Waiting for input...",
        ]
        if trimmedText.isEmpty || placeholderTexts.contains(trimmedText) {
            return ""
        }
    }
    return trimmedText
}

// ─── Message content views ──────────────────────────────────────────

private struct UserAttachmentThumbnailView: View {
    let attachment: CodexImageAttachment
    private let side = TurnAttachmentThumbnailMetrics.side
    private let cornerRadius = TurnAttachmentThumbnailMetrics.cornerRadius

    var body: some View {
        if let image = thumbnailUIImage {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: side, height: side)
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .stroke(Color(.separator), lineWidth: 1)
                )
        } else {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color(.secondarySystemFill))
                .frame(width: side, height: side)
                .overlay(
                    Image(systemName: "photo")
                        .foregroundStyle(.secondary)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .stroke(Color(.separator), lineWidth: 1)
                )
        }
    }

    private var thumbnailUIImage: UIImage? {
        guard !attachment.thumbnailBase64JPEG.isEmpty,
              let data = Data(base64Encoded: attachment.thumbnailBase64JPEG) else {
            return nil
        }
        return UIImage(data: data)
    }
}

private struct UserAttachmentStrip: View {
    let attachments: [CodexImageAttachment]
    let onTap: (CodexImageAttachment) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            ForEach(attachments) { attachment in
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    onTap(attachment)
                } label: {
                    UserAttachmentThumbnailView(attachment: attachment)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

// ─── Message row ────────────────────────────────────────────────────

private struct UserBubbleTextBlock<Content: View>: View {
    private static var collapseLineLimit: Int { 10 }
    private static var collapseCharacterThreshold: Int { 360 }
    private static var collapseNewlineThreshold: Int { 8 }

    let contentIdentity: String
    let rawText: String
    var contentResetKey: String? = nil
    var collapsesWithLineLimit: Bool = true
    @ViewBuilder let content: (_ isCollapsed: Bool) -> Content

    @State private var isExpanded = false

    private var canCollapse: Bool {
        var characterCount = 0
        var newlineCount = 0
        for character in rawText {
            characterCount += 1
            if characterCount > Self.collapseCharacterThreshold {
                return true
            }
            if character == "\n" {
                newlineCount += 1
                if newlineCount >= Self.collapseNewlineThreshold {
                    return true
                }
            }
        }
        return false
    }

    private var collapseResetKey: String {
        "\(contentIdentity)|\(contentResetKey ?? TurnTextCacheKey.stableFingerprint(for: rawText))"
    }

    private static var collapsedContentMaxHeight: CGFloat {
        UIFont.preferredFont(forTextStyle: .body).lineHeight * CGFloat(collapseLineLimit)
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            collapsibleContent

            if canCollapse {
                Button(isExpanded ? "Show less" : "Show more") {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        isExpanded.toggle()
                    }
                }
                .buttonStyle(.plain)
                .font(AppFont.footnote())
                .foregroundStyle(.secondary)
            }
        }
        .onChange(of: collapseResetKey) { _, _ in
            isExpanded = false
        }
    }

    @ViewBuilder
    private var collapsibleContent: some View {
        let isCollapsed = canCollapse && !isExpanded
        if collapsesWithLineLimit {
            content(isCollapsed)
                .lineLimit(isCollapsed ? Self.collapseLineLimit : nil)
        } else {
            content(isCollapsed)
                .frame(maxHeight: isCollapsed ? Self.collapsedContentMaxHeight : nil, alignment: .top)
                .clipped()
                .allowsHitTesting(!isCollapsed)
        }
    }
}

struct MessageRow: View, Equatable {

    let message: CodexMessage
    let isRetryAvailable: Bool
    let onRetryUserMessage: (String) -> Void
    // Keeps the end-of-block accessory aligned with the active assistant turn.
    var assistantBlockAccessoryState: AssistantBlockAccessoryState? = nil
    var planSessionSource: CodexPlanSessionSource? = nil
    var allowsAssistantPlanFallbackRecovery: Bool = false
    var assistantTurnCompleted: Bool = false
    var threadMessagesForPlanMatching: [CodexMessage] = []
    var currentWorkingDirectory: String? = nil
    // Narrow token for inferred-plan fallback invalidation; this changes only when the
    // relevant native structured prompts change, not on every unrelated service mutation.
    var planMatchingFingerprint: Int = 0
    // Disables timer-driven adornments while the user reads older content.
    var showsStreamingAnimations: Bool = true
    // Passed as init params instead of @Environment so .equatable() can short-circuit
    // without environment rebinding forcing a body re-evaluation on scroll-up cell reuse.
    var assistantRevertAction: ((CodexMessage) -> Void)? = nil
    var subagentOpenAction: ((CodexSubagentThreadPresentation) -> Void)? = nil
    @State private var previewImage: PreviewImagePayload?
    @State private var selectableTextSheet: SelectableMessageTextSheetState?
    @State private var throttledAssistantDisplayText: String?
    @State private var pendingAssistantDisplayText: String?
    @State private var assistantDisplayUpdateTask: Task<Void, Never>?
    @State private var assistantDisplaySyncTask: Task<Void, Never>?

    static func == (lhs: MessageRow, rhs: MessageRow) -> Bool {
        lhs.message == rhs.message
            && lhs.isRetryAvailable == rhs.isRetryAvailable
            && lhs.assistantBlockAccessoryState == rhs.assistantBlockAccessoryState
            && lhs.planSessionSource == rhs.planSessionSource
            && lhs.allowsAssistantPlanFallbackRecovery == rhs.allowsAssistantPlanFallbackRecovery
            && lhs.assistantTurnCompleted == rhs.assistantTurnCompleted
            && lhs.currentWorkingDirectory == rhs.currentWorkingDirectory
            && lhs.planMatchingFingerprint == rhs.planMatchingFingerprint
            && lhs.showsStreamingAnimations == rhs.showsStreamingAnimations
    }

    // Computed once per body evaluation and reused by all sub-views.
    private var displayText: String {
        if message.role == .assistant, message.isStreaming {
            if let throttledAssistantDisplayText {
                return throttledAssistantDisplayText
            }

            // Let the first small chunk appear immediately so a fresh send does not
            // feel stalled, while still blocking recovered/coalesced large buffers.
            let liveText = timelineDisplayText(for: message)
            return shouldShowInitialStreamingText(liveText) ? liveText : ""
        }

        return timelineDisplayText(for: message)
    }

    private func shouldShowInitialStreamingText(_ text: String) -> Bool {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return false
        }
        return text.utf8.count <= 512
    }

    private func shouldSynchronizeAssistantDisplayImmediately() -> Bool {
        guard message.isStreaming else { return true }
        if showsStreamingAnimations {
            return true
        }
        return shouldShowInitialStreamingText(timelineDisplayText(for: message))
    }

    var body: some View {
        let text = displayText
        let renderModel = MessageRowRenderModelCache.model(for: message, displayText: text)
        Group {
            switch message.role {
            case .user:
                userBubble(text: text)
            case .assistant:
                assistantView(text: text, renderModel: renderModel)
            case .system:
                VStack(alignment: .leading, spacing: 8) {
                    systemView(text: text, renderModel: renderModel)
                    if hasTurnEndActions {
                        turnEndActionButtons
                    }
                    if let assistantBlockAccessoryState {
                        CopyBlockButton(
                            text: assistantBlockAccessoryState.allowsCopy ? assistantBlockAccessoryState.copyText : nil,
                            isRunning: assistantBlockAccessoryState.showsRunningIndicator
                        )
                    }
                }
                // Keep block-end actions pinned left when a system row is the last item in a turn.
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .sheet(item: $selectableTextSheet) { sheet in
            SelectableMessageTextSheet(state: sheet)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipped()
        .onAppear {
            synchronizeAssistantDisplayText(immediate: true)
        }
        .onChange(of: message.text) { _, _ in
            scheduleAssistantDisplayTextSync(immediate: shouldSynchronizeAssistantDisplayImmediately())
        }
        .onChange(of: message.isStreaming) { _, isStreaming in
            synchronizeAssistantDisplayText(immediate: !isStreaming)
        }
        .onDisappear {
            assistantDisplaySyncTask?.cancel()
            assistantDisplaySyncTask = nil
            assistantDisplayUpdateTask?.cancel()
            assistantDisplayUpdateTask = nil
        }
    }

    private func userBubble(text: String) -> some View {
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

    private func assistantView(text: String, renderModel: MessageRowRenderModel) -> some View {
        let commentContent = renderModel.codeCommentContent
        let bodyText = commentContent?.fallbackText ?? text
        let mermaidContent = renderModel.mermaidContent
        let shouldParseStructuredAssistantContent = !message.isStreaming
        let assistantProposedPlanCandidate = shouldParseStructuredAssistantContent
            && commentContent == nil && mermaidContent == nil
            ? (message.proposedPlan ?? CodexProposedPlanParser.parse(from: bodyText))
            : nil
        let currentPlanSessionSource = planSessionSource
        let isNativePlanSession = currentPlanSessionSource != nil && currentPlanSessionSource != .compatibilityFallback
        let proposedPlan = !isNativePlanSession
            ? (assistantProposedPlanCandidate
                ?? (
                    commentContent == nil
                        && mermaidContent == nil
                        && currentPlanSessionSource == .compatibilityFallback
                        && InferredPlanQuestionnaireParser.parseAssistantMessage(bodyText) == nil
                    ? CodexProposedPlanParser.parseAssistantFallback(from: bodyText)
                            : nil
                ))
            : nil
        let renderedPlanText = assistantProposedPlanCandidate == nil
            ? bodyText
            : (
                CodexProposedPlanParser.containsEnvelope(in: bodyText)
                    ? (CodexProposedPlanParser.removingEnvelope(from: bodyText) ?? "")
                    : ""
            )
        let inferredQuestionnaire = shouldParseStructuredAssistantContent && commentContent == nil
            ? resolvedInferredPlanQuestionnaire(
                bodyText: bodyText,
                message: message,
                threadMessages: threadMessagesForPlanMatching,
                shouldRecoverFallback: allowsAssistantPlanFallbackRecovery,
                parse: InferredPlanQuestionnaireParser.parseAssistantMessage
            )
            : nil
        let visibleAssistantText = renderedPlanText
        let suppressNativeProposedPlanShell = isNativePlanSession
            && assistantProposedPlanCandidate != nil
            && visibleAssistantText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && inferredQuestionnaire == nil
            && mermaidContent == nil
        let usesCachedAssistantImageContent = !message.isStreaming && visibleAssistantText == bodyText
        let assistantImageReferences = usesCachedAssistantImageContent
            ? renderModel.assistantImageReferences
            : []
        let assistantInlineContentSegments = usesCachedAssistantImageContent
            ? renderModel.assistantInlineContentSegments
            : []
        let trailingAssistantImageReferences = assistantImageReferences.filter {
            !$0.isTemporaryScreenshotImage
                && $0.canPreview(currentWorkingDirectory: currentWorkingDirectory)
        }
        let visibleAssistantTextWithoutImageSyntax = assistantImageReferences.isEmpty
            ? visibleAssistantText
            : (renderModel.assistantTextWithoutImageSyntax ?? visibleAssistantText)
        let trimmedVisibleAssistantText = visibleAssistantTextWithoutImageSyntax
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let hasVisibleAssistantText = !trimmedVisibleAssistantText.isEmpty
        let assistantImageAttachments = message.isStreaming
            ? []
            : message.attachments.filter(\.hasPreviewPayload)
        let rendersTemporaryImagesInline = !assistantInlineContentSegments.isEmpty
            && !message.isStreaming
            && mermaidContent == nil
            && proposedPlan == nil
            && inferredQuestionnaire == nil
        let hasRenderableAssistantContent = hasVisibleAssistantText
            || proposedPlan != nil
            || !trailingAssistantImageReferences.isEmpty
            || rendersTemporaryImagesInline
            || !assistantImageAttachments.isEmpty
        // Copy only the visible prose. Image-only artifact rows should not expose a
        // second copy affordance for the hidden markdown image syntax.
        let assistantCopyText: String? = {
            if !trimmedVisibleAssistantText.isEmpty {
                return trimmedVisibleAssistantText
            }
            return trailingAssistantImageReferences.isEmpty ? assistantBlockAccessoryState?.copyText : nil
        }()
        return VStack(alignment: .leading, spacing: 8) {
            if let commentContent, commentContent.hasFindings {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(commentContent.findings) { finding in
                        CodeCommentFindingCard(finding: finding)
                    }
                }
            }

            if hasRenderableAssistantContent {
                if let mermaidContent {
                    MermaidMarkdownContentView(content: mermaidContent)
                } else if let inferredQuestionnaire {
                    if let introText = inferredQuestionnaire.introText {
                        MarkdownTextView(
                            text: introText,
                            profile: .assistantProse,
                            enablesSelection: enablesInlineMarkdownSelectionInTimeline,
                            constrainsToAvailableWidth: true
                        )
                    }

                    InferredPlanQuestionnaireCard(
                        message: message,
                        questionnaire: inferredQuestionnaire
                    )

                    if let outroText = inferredQuestionnaire.outroText {
                        Text(outroText)
                            .font(AppFont.footnote())
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else if let proposedPlan {
                    // Compatibility-mode proposed plans still render inline from assistant text.
                    if !renderedPlanText.isEmpty {
                        MarkdownTextView(
                            text: renderedPlanText,
                            profile: .assistantProse,
                            enablesSelection: enablesInlineMarkdownSelectionInTimeline,
                            constrainsToAvailableWidth: true
                        )
                    }

                    ProposedPlanResultCard(
                        threadId: message.threadId,
                        proposedPlan: proposedPlan,
                        isStreaming: message.isStreaming,
                        canImplement: assistantTurnCompleted
                    )
                } else if rendersTemporaryImagesInline {
                    ForEach(assistantInlineContentSegments) { segment in
                        switch segment {
                        case .text(_, let segmentText):
                            MarkdownTextView(
                                text: segmentText,
                                profile: .assistantProse,
                                enablesSelection: enablesInlineMarkdownSelectionInTimeline,
                                constrainsToAvailableWidth: true
                            )
                        case .image(let reference):
                            if reference.canPreview(currentWorkingDirectory: currentWorkingDirectory) {
                                AssistantMarkdownImagePreviewButton(
                                    reference: reference,
                                    currentWorkingDirectory: currentWorkingDirectory
                                )
                            }
                        }
                    }
                } else if message.isStreaming {
                    streamingAssistantContent(
                        hasVisibleAssistantText: hasVisibleAssistantText,
                        visibleAssistantTextWithoutImageSyntax: visibleAssistantTextWithoutImageSyntax
                    )
                } else {
                    if hasVisibleAssistantText {
                        MarkdownTextView(
                            text: visibleAssistantTextWithoutImageSyntax,
                            profile: .assistantProse,
                            enablesSelection: enablesInlineMarkdownSelectionInTimeline,
                            constrainsToAvailableWidth: true
                        )
                    }
                }

                if !trailingAssistantImageReferences.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(trailingAssistantImageReferences) { reference in
                            AssistantMarkdownImagePreviewButton(
                                reference: reference,
                                currentWorkingDirectory: currentWorkingDirectory
                            )
                        }
                    }
                }

                if !assistantImageAttachments.isEmpty {
                    UserAttachmentStrip(attachments: assistantImageAttachments) { tappedAttachment in
                        if let image = AttachmentPreviewImageResolver.resolve(tappedAttachment) {
                            previewImage = PreviewImagePayload(image: image)
                        }
                    }
                    .padding(.top, trailingAssistantImageReferences.isEmpty ? 0 : 4)
                }
            }

            if !suppressNativeProposedPlanShell && hasTurnEndActions {
                turnEndActionButtons
            }

            if !suppressNativeProposedPlanShell, let assistantBlockAccessoryState {
                CopyBlockButton(
                    text: assistantBlockAccessoryState.allowsCopy ? assistantCopyText : nil,
                    isRunning: assistantBlockAccessoryState.showsRunningIndicator
                )
            }

        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            selectableTextActions(text: text, usesMarkdownSelection: true)
        }
    }

    @ViewBuilder
    private func streamingAssistantContent(
        hasVisibleAssistantText: Bool,
        visibleAssistantTextWithoutImageSyntax: String
    ) -> some View {
        if hasVisibleAssistantText {
            StreamingAssistantMarkdownTextView(
                text: visibleAssistantTextWithoutImageSyntax,
                enablesSelection: enablesInlineMarkdownSelectionInTimeline,
                constrainsToAvailableWidth: true,
                animatesReveal: showsStreamingAnimations
            )
        }
    }

    @ViewBuilder
    private func systemView(text: String, renderModel: MessageRowRenderModel) -> some View {
        switch message.kind {
        case .thinking:
            thinkingSystemView(renderModel: renderModel)
        case .toolActivity:
            toolActivitySystemView(text: text)
        case .fileChange:
            fileChangeSystemView(text: text, renderModel: renderModel)
        case .commandExecution:
            commandExecutionSystemView(text: text, renderModel: renderModel)
        case .subagentAction:
            subagentActionSystemView(text: text)
        case .plan:
            if message.resolvedPlanPresentation?.isInlineResultVisible == true,
               let proposedPlan = message.proposedPlan {
                ProposedPlanResultCard(
                    threadId: message.threadId,
                    proposedPlan: proposedPlan,
                    isStreaming: message.isStreaming,
                    canImplement: message.resolvedPlanPresentation == .resultReady
                )
            } else {
                PlanSystemCard(message: message)
            }
        case .userInputPrompt:
            if let request = message.structuredUserInputRequest {
                StructuredUserInputCard(request: request)
                    .id(request.requestID)
            } else {
                defaultSystemView(text: text)
            }
        case .chat:
            defaultSystemView(text: text)
        }
    }

    @ViewBuilder
    private func thinkingSystemView(renderModel: MessageRowRenderModel) -> some View {
        ThinkingSystemBlock(
            messageID: message.id,
            isStreaming: message.isStreaming,
            thinkingText: renderModel.thinkingText ?? "",
            thinkingContent: renderModel.thinkingContent ?? ThinkingDisclosureContent(sections: [], fallbackText: ""),
            activityPreview: renderModel.thinkingActivityPreview
        )
    }

    private func toolActivitySystemView(text: String) -> some View {
        let joined = text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")

        return VStack(alignment: .leading, spacing: 4) {
            if !joined.isEmpty {
                Text(joined)
                    .font(AppFont.body(weight: .regular))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
        .contextMenu {
            selectableTextActions(text: text, usesMarkdownSelection: false)
        }
    }

    @ViewBuilder
    private func fileChangeSystemView(text: String, renderModel: MessageRowRenderModel) -> some View {
        let renderState = renderModel.fileChangeState ?? FileChangeRenderState(
            summary: nil,
            actionEntries: [],
            bodyText: text
        )
        let actionEntries = renderState.actionEntries
        let hasActionRows = !actionEntries.isEmpty
        let allEntries = hasActionRows ? actionEntries : (renderState.summary?.entries ?? [])
        let fallbackText = renderState.bodyText.trimmingCharacters(in: .whitespacesAndNewlines)

        if message.isStreaming {
            fileChangeStreamingSystemView(
                text: text,
                entries: allEntries,
                fallbackText: fallbackText
            )
        } else {
            VStack(alignment: .leading, spacing: 8) {
                FileChangeSummaryBox(
                    entries: allEntries,
                    fallbackText: fallbackText,
                    messageID: message.id
                )
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contextMenu {
                selectableTextActions(text: text, usesMarkdownSelection: false)
            }
        }
    }

    private func fileChangeStreamingSystemView(
        text: String,
        entries: [TurnFileChangeSummaryEntry],
        fallbackText: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if entries.isEmpty {
                Text(fallbackText.isEmpty ? text : fallbackText)
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(entries) { entry in
                    FileChangeInlineActionRow(entry: entry)
                }
            }

        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            selectableTextActions(text: text, usesMarkdownSelection: false)
        }
    }

    private func defaultSystemView(text: String) -> some View {
        Text(text)
            .font(AppFont.footnote())
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 2)
            .contextMenu {
                selectableTextActions(text: text, usesMarkdownSelection: false)
            }
    }

    @ViewBuilder
    private func commandExecutionSystemView(text: String, renderModel: MessageRowRenderModel) -> some View {
        if message.role == .system,
           message.kind == .commandExecution,
           !text.isEmpty,
           let commandStatus = renderModel.commandStatus {
            CommandExecutionStatusCard(status: commandStatus, itemId: message.itemId)
        } else {
            defaultSystemView(text: text)
        }
    }

    @ViewBuilder
    private func subagentActionSystemView(text: String) -> some View {
        if let subagentAction = message.subagentAction {
            SubagentActionCard(
                parentThreadId: message.threadId,
                action: subagentAction,
                onOpenSubagent: subagentOpenAction
            )
        } else {
            defaultSystemView(text: text)
        }
    }


    private var deliveryStatusText: String? {
        guard message.role == .user else { return nil }

        switch message.deliveryState {
        case .pending:
            return "sending..."
        case .failed:
            return "send failed"
        case .confirmed:
            return message.formattedTimelineTime()
        }
    }

    @Environment(\.inlineCommitAndPushAction) private var inlineCommitAction
    @Environment(\.inlineCommitAndPushPhase) private var inlineCommitAndPushPhase
    @State private var isShowingBlockDiffSheet = false

    private var hasTurnEndActions: Bool {
        AssistantTurnEndActionVisibility.shouldShow(
            accessoryState: assistantBlockAccessoryState
        )
    }

    private var isInlineCommitAndPushRunning: Bool {
        inlineCommitAndPushPhase != nil
    }

    private var inlineCommitAndPushTitle: String {
        inlineCommitAndPushPhase?.title ?? "Commit & Push"
    }

    @ViewBuilder
    private var turnEndActionButtons: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let accessory = assistantBlockAccessoryState,
               let revert = accessory.blockRevertPresentation {
                assistantRevertButton(
                    presentation: revert,
                    targetMessage: accessory.blockRevertMessage ?? message
                )
            }

            if let accessory = assistantBlockAccessoryState {
                HStack(spacing: 10) {
                    if let entries = accessory.blockDiffEntries, !entries.isEmpty {
                        let totalAdditions = entries.reduce(0) { $0 + $1.additions }
                        let totalDeletions = entries.reduce(0) { $0 + $1.deletions }

                        Button {
                            isShowingBlockDiffSheet = true
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "doc.text.magnifyingglass")
                                    .font(AppFont.system(size: 10, weight: .medium))
                                Text("Diff")
                                DiffCountsLabel(additions: totalAdditions, deletions: totalDeletions)
                            }
                            .font(AppFont.mono(.body))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .sheet(isPresented: $isShowingBlockDiffSheet) {
                            TurnDiffSheet(
                                title: "Changes",
                                entries: entries,
                                bodyText: accessory.blockDiffText ?? "",
                                messageID: message.id
                            )
                        }
                    }

                    if let action = inlineCommitAction {
                        Button {
                            HapticFeedback.shared.triggerImpactFeedback(style: .light)
                            action()
                        } label: {
                            HStack(spacing: 4) {
                                // Mirror the top-bar git feedback so the inline CTA feels responsive too.
                                Group {
                                    if isInlineCommitAndPushRunning {
                                        ProgressView()
                                            .controlSize(.small)
                                    } else {
                                        Image("cloud-upload")
                                            .renderingMode(.template)
                                            .resizable()
                                            .scaledToFit()
                                    }
                                }
                                    .frame(width: 18, height: 18)
                                Text(inlineCommitAndPushTitle)
                            }
                            .font(AppFont.mono(.body))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(isInlineCommitAndPushRunning)
                    }
                }
            }
        }
    }

    private func assistantRevertButton(
        presentation: AssistantRevertPresentation,
        targetMessage: CodexMessage
    ) -> some View {
        let iconName: String = {
            switch presentation.riskLevel {
            case .safe:
                return "arrow.uturn.backward.circle"
            case .warning:
                return "exclamationmark.circle"
            case .blocked:
                return "exclamationmark.triangle"
            }
        }()
        let accentColor: Color = {
            switch presentation.riskLevel {
            case .safe:
                return .primary
            case .warning:
                return .orange
            case .blocked:
                return .secondary
            }
        }()

        return Button {
            guard presentation.isEnabled else { return }
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            assistantRevertAction?(targetMessage)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: iconName)
                    .font(AppFont.system(size: 10, weight: .medium))
                    .foregroundStyle(accentColor)
                Text(presentation.title)
                    .lineLimit(1)
            }
            .font(AppFont.mono(.body))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!presentation.isEnabled)
        .accessibilityHint(presentation.warningText ?? presentation.helperText ?? "")
    }

    @ViewBuilder
    private func selectableTextActions(text: String, usesMarkdownSelection: Bool) -> some View {
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedText.isEmpty {
            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                selectableTextSheet = SelectableMessageTextSheetState(
                    role: message.role,
                    text: trimmedText,
                    usesMarkdownSelection: usesMarkdownSelection
                )
            } label: {
                Label("Select Text", systemImage: "text.cursor")
            }

            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                UIPasteboard.general.string = trimmedText
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
        }
    }

    // Throttles only the assistant row's visible text during streaming so markdown/layout
    // work stays local to that cell instead of firing on every token delta.
    private func scheduleAssistantDisplayTextSync(immediate: Bool) {
        assistantDisplaySyncTask?.cancel()
        // Streaming can deliver several String changes in one SwiftUI frame. Deferring
        // this state write avoids the "onChange(of: String) updated multiple times"
        // runtime warning while still applying the newest text on the next turn.
        assistantDisplaySyncTask = Task { @MainActor in
            await Task.yield()
            guard !Task.isCancelled else { return }
            synchronizeAssistantDisplayText(immediate: immediate)
            assistantDisplaySyncTask = nil
        }
    }

    private func synchronizeAssistantDisplayText(immediate: Bool) {
        guard message.role == .assistant else {
            assistantDisplaySyncTask?.cancel()
            assistantDisplaySyncTask = nil
            throttledAssistantDisplayText = nil
            pendingAssistantDisplayText = nil
            assistantDisplayUpdateTask?.cancel()
            assistantDisplayUpdateTask = nil
            return
        }

        let nextText = timelineDisplayText(for: message)
        pendingAssistantDisplayText = nextText

        guard message.isStreaming else {
            assistantDisplayUpdateTask?.cancel()
            assistantDisplayUpdateTask = nil
            throttledAssistantDisplayText = nextText
            return
        }

        if immediate {
            assistantDisplayUpdateTask?.cancel()
            assistantDisplayUpdateTask = nil
            throttledAssistantDisplayText = nextText
            return
        }

        if assistantDisplayUpdateTask != nil {
            return
        }

        assistantDisplayUpdateTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled else { return }
            throttledAssistantDisplayText = pendingAssistantDisplayText ?? nextText
            assistantDisplayUpdateTask = nil
        }
    }
}

private struct SelectableMessageTextSheetState: Identifiable {
    let id = UUID()
    let role: CodexMessageRole
    let text: String
    let usesMarkdownSelection: Bool

    var title: String {
        switch role {
        case .assistant:
            return "Assistant Message"
        case .system:
            return "System Message"
        case .user:
            return "Message"
        }
    }
}

private struct SelectableMessageTextSheet: View {
    let state: SelectableMessageTextSheetState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if state.usesMarkdownSelection {
                        MarkdownTextView(
                            text: state.text,
                            profile: .assistantProse,
                            enablesSelection: true
                        )
                    } else {
                        Text(state.text)
                            .font(AppFont.body())
                            .foregroundStyle(.primary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(16)
            }
            .navigationTitle(state.title)
            .navigationBarTitleDisplayMode(.inline)
            .adaptiveNavigationBar()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
private struct CommandExecutionStatusCard: View {
    let status: CommandExecutionStatusModel
    let itemId: String?
    @Environment(CodexService.self) private var codex
    @State private var isShowingDetailSheet = false
    @State private var isLoadingImagePreview = false
    @State private var imagePreviewError: String?
    @State private var previewImage: PreviewImagePayload?
    @State private var unavailableImagePreviewPaths: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            CommandExecutionCardBody(
                command: status.command,
                statusLabel: status.statusLabel,
                accent: status.accent
            )
                .contentShape(Rectangle())
                .onTapGesture {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    isShowingDetailSheet = true
                }

            if let imageReference {
                commandImagePreviewButton(for: imageReference)
            }
        }
            .sheet(isPresented: $isShowingDetailSheet) {
                CommandExecutionDetailSheet(status: status, details: detailModel)
                    .presentationDetents([.fraction(0.35), .medium])
            }
            .fullScreenCover(item: $previewImage) { payload in
                ZoomableImagePreviewScreen(
                    payload: payload,
                    onDismiss: { previewImage = nil }
                )
            }
            .alert("Image Preview", isPresented: imagePreviewErrorIsPresented, actions: {
                Button("OK", role: .cancel) {
                    imagePreviewError = nil
                }
            }, message: {
                Text(imagePreviewError ?? "")
            })
    }

    private var detailModel: CommandExecutionDetails? {
        guard let itemId else { return nil }
        return codex.commandExecutionDetailsByItemID[itemId]
    }

    private var imageReference: CommandOutputImageReference? {
        guard let details = detailModel else {
            return nil
        }
        guard let reference = CommandOutputImageReferenceParser.firstReference(
            command: details.fullCommand,
            outputTail: details.outputTail,
            cwd: details.cwd
        ) else {
            return nil
        }
        return unavailableImagePreviewPaths.contains(reference.path) ? nil : reference
    }

    private func commandImagePreviewButton(for reference: CommandOutputImageReference) -> some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            loadImagePreview(reference)
        } label: {
            HStack(spacing: 8) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color(.secondarySystemFill))
                    if isLoadingImagePreview {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "photo")
                            .font(AppFont.system(size: 14, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: 32, height: 32)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Image")
                        .font(AppFont.caption(weight: .medium))
                        .foregroundStyle(.secondary)
                    Text(reference.fileName)
                        .font(AppFont.mono(.caption))
                        .foregroundStyle(.primary.opacity(0.78))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(AppFont.system(size: 8, weight: .semibold))
                    .foregroundStyle(.quaternary)
            }
            .padding(8)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(.secondarySystemBackground).opacity(0.55))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color(.separator).opacity(0.55), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(isLoadingImagePreview)
    }

    private func loadImagePreview(_ reference: CommandOutputImageReference) {
        guard !isLoadingImagePreview else { return }
        isLoadingImagePreview = true

        Task { @MainActor in
            defer { isLoadingImagePreview = false }
            do {
                let cachedPreview = await WorkspaceImagePreviewCache.shared.cachedPreview(forPath: reference.path)
                let result = try await codex.readWorkspaceImage(
                    path: reference.path,
                    cwd: detailModel?.cwd,
                    cachedMetadata: cachedPreview?.metadata
                )
                if result.isNotModified, let cachedPreview {
                    previewImage = PreviewImagePayload(
                        image: cachedPreview.payload.image,
                        title: cachedPreview.metadata.fileName.isEmpty ? reference.fileName : cachedPreview.metadata.fileName
                    )
                    return
                }

                let decodedImage = try await WorkspaceImagePreviewCache.shared.preview(for: result)
                previewImage = PreviewImagePayload(
                    image: decodedImage.image,
                    title: result.fileName.isEmpty ? reference.fileName : result.fileName
                )
            } catch {
                if Self.isMissingWorkspaceImageError(error) {
                    unavailableImagePreviewPaths.insert(reference.path)
                    return
                }
                imagePreviewError = error.localizedDescription
            }
        }
    }

    // Stale temp image previews are expected after streaming; hide the ghost row instead of interrupting the user.
    private static func isMissingWorkspaceImageError(_ error: Error) -> Bool {
        if case CodexServiceError.rpcError(let rpcError) = error {
            return rpcError.message.localizedCaseInsensitiveContains("image file no longer exists")
                || rpcError.message.localizedCaseInsensitiveContains("no longer exists")
        }
        return error.localizedDescription.localizedCaseInsensitiveContains("image file no longer exists")
    }

    private var imagePreviewErrorIsPresented: Binding<Bool> {
        Binding(
            get: { imagePreviewError != nil },
            set: { isPresented in
                if !isPresented {
                    imagePreviewError = nil
                }
            }
        )
    }
}

// ─── Subagent UI — see SubagentViews.swift ──────────────────────

// ─── Shared diff counts ─────────────────────────────────────────────

/// Compact `+N -M` label in green/red. Caller applies `.font()`.
struct DiffCountsLabel: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 4) {
            Text("+\(additions)")
                .foregroundStyle(Color.green)
            Text("-\(deletions)")
                .foregroundStyle(Color.red)
        }
    }
}

// ─── Approval banner ────────────────────────────────────────────────

struct ApprovalBanner: View {
    let request: CodexApprovalRequest
    let isLoading: Bool
    let onApprove: () -> Void
    let onDecline: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Approval request", systemImage: "checkmark.shield")
                .font(AppFont.subheadline())

            if let command = request.command, !command.isEmpty {
                Text(command)
                    .font(AppFont.mono(.callout))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            } else if let reason = request.reason, !reason.isEmpty {
                Text(reason)
                    .font(AppFont.callout())
            } else {
                Text(request.method)
                    .font(AppFont.callout())
            }

            HStack {
                Button("Approve", action: {
                    HapticFeedback.shared.triggerImpactFeedback()
                    onApprove()
                })
                    .buttonStyle(.borderedProminent)

                Button("Deny", role: .destructive, action: {
                    HapticFeedback.shared.triggerImpactFeedback()
                    onDecline()
                })
                    .buttonStyle(.bordered)
            }
            .disabled(isLoading)
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

// ─── Focused Previews ───────────────────────────────────────────────

struct TimelineSystemBlockPreviewSurface<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .background(Color(.systemBackground))
    }
}

@MainActor
struct ToolCallSystemBlockPreviewHost: View {
    var body: some View {
        TimelineSystemBlockPreviewSurface {
            CommandExecutionStatusCard(
                status: CommandExecutionStatusModel(
                    command: "npm run lint -- --fix",
                    statusLabel: "completed",
                    accent: .completed
                ),
                itemId: "preview-tool-call"
            )
        }
        .environment(CodexService())
    }
}

enum AssistantTurnEndActionVisibility {
    // Ties Diff/Revert to the block's own streaming state so interrupted and
    // turn-less recovered rows keep their end-of-turn controls once settled.
    static func shouldShow(accessoryState: AssistantBlockAccessoryState?) -> Bool {
        guard let accessoryState, !accessoryState.showsRunningIndicator else { return false }
        return accessoryState.blockRevertPresentation != nil
            || accessoryState.blockDiffEntries != nil
    }
}
#Preview("Tool Call Block") {
    ToolCallSystemBlockPreviewHost()
}
