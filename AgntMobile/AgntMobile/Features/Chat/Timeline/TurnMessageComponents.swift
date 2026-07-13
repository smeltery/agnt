// FILE: TurnMessageComponents.swift
// Purpose: SwiftUI views for rendering turn messages: MessageRow, ApprovalBanner, and subviews.
// Layer: View Components
// Exports: MessageRow, ApprovalBanner
// Depends on: SwiftUI, TurnMessageRegexCache, SkillReferenceFormatter,
//   ThinkingDisclosureParser, CodeCommentDirectiveParser, TurnFileChangeSummaryParser,
//   TurnMessageCaches, TurnMarkdownModels, TurnDiffRenderer, CommandExecutionViews

import ImageIO
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

// ─── File-Change Recap UI ─────────────────────────────────────

// MARK: - FileChangeInlineActionRow
// Keeps live file-change deltas as lightweight status rows while a turn is still streaming.
private struct FileChangeInlineActionRow: View {
    let entry: TurnFileChangeSummaryEntry
    var showActionLabel: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if showActionLabel {
                Text(entry.action?.rawValue ?? "Edited")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary.opacity(0.6))
            }

            HStack(spacing: 6) {
                Text(entry.compactPath)
                    .foregroundStyle(Color.blue)
                    .lineLimit(1)
                    .truncationMode(.middle)

                DiffCountsLabel(additions: entry.additions, deletions: entry.deletions)
                    .font(AppFont.subheadline())
            }
            .font(AppFont.body())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - FileChangeSummaryBox
// Renders turn-end file edits as one compact recap instead of chat-like rows.
enum FileChangeSummaryPreview {
    static let previewEntryLimit = 3

    static func visibleEntries(
        from entries: [TurnFileChangeSummaryEntry],
        showsAllEntries: Bool
    ) -> ArraySlice<TurnFileChangeSummaryEntry> {
        showsAllEntries ? entries[...] : entries.prefix(previewEntryLimit)
    }

    static func hiddenEntryCount(
        totalEntryCount: Int,
        showsAllEntries: Bool
    ) -> Int {
        showsAllEntries ? 0 : max(0, totalEntryCount - previewEntryLimit)
    }
}

private struct FileChangeSummaryBox: View {
    let entries: [TurnFileChangeSummaryEntry]
    let fallbackText: String
    let messageID: String

    // Default to expanded so the recap stays informative without an extra tap;
    // collapse remains available for long lists or visual decluttering.
    @State private var isExpanded: Bool = true
    @State private var showsAllEntries: Bool = false
    @State private var selectedEntry: TurnFileChangeSummaryEntry?

    private var canCollapse: Bool {
        !entries.isEmpty || !fallbackText.isEmpty
    }

    private var visibleEntries: ArraySlice<TurnFileChangeSummaryEntry> {
        FileChangeSummaryPreview.visibleEntries(
            from: entries,
            showsAllEntries: showsAllEntries
        )
    }

    private var hiddenEntryCount: Int {
        FileChangeSummaryPreview.hiddenEntryCount(
            totalEntryCount: entries.count,
            showsAllEntries: showsAllEntries
        )
    }

    private var hasEntryOverflow: Bool {
        entries.count > FileChangeSummaryPreview.previewEntryLimit
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            if isExpanded {
                if !entries.isEmpty {
                    Divider()

                    ForEach(Array(visibleEntries.enumerated()), id: \.element.id) { index, entry in
                        let isLastEntry = index == visibleEntries.count - 1

                        Button {
                            selectedEntry = entry
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(entry.compactPath)
                                    .font(AppFont.subheadline())
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)

                                Spacer(minLength: 8)

                                if entry.additions > 0 || entry.deletions > 0 {
                                    DiffCountsLabel(additions: entry.additions, deletions: entry.deletions)
                                        .font(AppFont.subheadline())
                                }
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 9)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        if !isLastEntry || hiddenEntryCount > 0 {
                            Divider()
                                .padding(.leading, 12)
                        }
                    }

                    if hiddenEntryCount > 0 || showsAllEntries && hasEntryOverflow {
                        Button {
                            withAnimation(.easeInOut(duration: 0.18)) {
                                showsAllEntries.toggle()
                            }
                        } label: {
                            HStack(spacing: 6) {
                                Text(showsAllEntries ? "Show less" : "Show more")
                                    .font(AppFont.subheadline(weight: .medium))

                                Image(systemName: "chevron.down")
                                    .font(AppFont.system(size: 10, weight: .semibold))
                                    .rotationEffect(.degrees(showsAllEntries ? 180 : 0))
                                    .accessibilityHidden(true)
                            }
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 9)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(
                            showsAllEntries
                                ? "Show fewer file changes"
                                : "Show \(hiddenEntryCount) more file changes"
                        )
                    }
                } else if !fallbackText.isEmpty {
                    Text(fallbackText)
                        .font(AppFont.footnote())
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 10)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color(.secondarySystemBackground),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(.separator).opacity(0.4), lineWidth: 0.5)
        }
        .padding(2)
        .sheet(item: $selectedEntry) { entry in
            TurnDiffSheet(
                title: entry.compactPath,
                entries: [entry],
                bodyText: fallbackText,
                messageID: messageID,
                restrictToPath: entry.path
            )
        }
    }

    @ViewBuilder
    private var header: some View {
        let content = HStack(spacing: 6) {
            Image(systemName: "pencil.line")
                .font(AppFont.footnote(weight: .semibold))
                .foregroundStyle(.secondary)

            Text(title)
                .font(AppFont.footnote(weight: .semibold))
                .foregroundStyle(.secondary)

            Spacer(minLength: 8)

            if canCollapse {
                Image(systemName: "chevron.down")
                    .font(AppFont.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isExpanded ? 0 : -90))
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, isExpanded && !entries.isEmpty ? 8 : 10)
        .contentShape(Rectangle())

        if canCollapse {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                content
            }
            .buttonStyle(.plain)
            .accessibilityLabel(title)
            .accessibilityHint(isExpanded ? "Collapse list" : "Expand list")
            .accessibilityAddTraits(.isButton)
        } else {
            content
        }
    }

    private var title: String {
        let count = entries.count
        if count == 0 {
            return "Files modified"
        }
        if count == 1 {
            return "1 file modified"
        }
        return "\(count) files modified"
    }
}

private struct CodeCommentFindingCard: View {
    let finding: CodeCommentDirectiveFinding

    private var priorityLevel: Int {
        min(max(finding.priority ?? 3, 0), 3)
    }

    private var priorityColor: Color {
        switch priorityLevel {
        case 0:
            return .red
        case 1:
            return .orange
        case 2:
            return .yellow
        default:
            return .blue
        }
    }

    private var fileName: String {
        finding.file.pathDisplayName
    }

    private var lineLabel: String? {
        guard let startLine = finding.startLine else { return nil }
        if let endLine = finding.endLine, endLine != startLine {
            return "L\(startLine)-\(endLine)"
        }
        return "L\(startLine)"
    }

    private var confidenceLabel: String? {
        guard let confidence = finding.confidence else { return nil }
        let clamped = min(max(confidence, 0), 1)
        return "\(Int((clamped * 100).rounded()))%"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("P\(priorityLevel)")
                    .font(AppFont.mono(.caption))
                    .foregroundStyle(priorityColor)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(priorityColor.opacity(0.12), in: Capsule())

                Text(finding.title)
                    .font(AppFont.body(weight: .semibold))
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)

                Spacer(minLength: 0)
            }

            Text(finding.body)
                .font(AppFont.body())
                .foregroundStyle(.primary.opacity(0.92))
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                Text(fileName)
                    .font(AppFont.mono(.caption))
                    .foregroundStyle(.primary.opacity(0.78))
                    .lineLimit(1)

                if let lineLabel {
                    Text(lineLabel)
                        .font(AppFont.mono(.caption))
                        .foregroundStyle(.secondary)
                }

                if let confidenceLabel {
                    Text(confidenceLabel)
                        .font(AppFont.mono(.caption))
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 0)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(priorityColor.opacity(0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(priorityColor.opacity(0.28), lineWidth: 1)
        )
        .textSelection(.enabled)
    }
}

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

private enum AttachmentPreviewImageResolver {
    // Uses full payload data URL first, then falls back to thumbnail for resilience.
    static func resolve(_ attachment: CodexImageAttachment) -> UIImage? {
        if let payloadDataURL = attachment.payloadDataURL,
           let imageData = decodeImageDataFromDataURL(payloadDataURL),
           let image = UIImage(data: imageData) {
            return image
        }

        guard !attachment.thumbnailBase64JPEG.isEmpty,
              let thumbnailData = Data(base64Encoded: attachment.thumbnailBase64JPEG) else {
            return nil
        }
        return UIImage(data: thumbnailData)
    }

    private static func decodeImageDataFromDataURL(_ dataURL: String) -> Data? {
        guard let commaIndex = dataURL.firstIndex(of: ",") else {
            return nil
        }

        let metadata = dataURL[..<commaIndex].lowercased()
        guard metadata.hasPrefix("data:image"),
              metadata.contains(";base64") else {
            return nil
        }

        let payloadStart = dataURL.index(after: commaIndex)
        return Data(base64Encoded: String(dataURL[payloadStart...]))
    }
}

private struct AssistantMarkdownImagePreviewButton: View {
    let reference: AssistantMarkdownImageReference
    let currentWorkingDirectory: String?

    @Environment(CodexService.self) private var codex
    @State private var previewRequest: AssistantWorkspaceImagePreviewRequest?
    @State private var loadedPreview: PreviewImagePayload?
    @State private var isAutoLoadingPreview = false
    @State private var didAttemptAutoPreviewLoad = false

    private static let cornerRadius: CGFloat = 18
    private static let maxWidth: CGFloat = 200

    var body: some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            openPreview()
        } label: {
            content
        }
        .buttonStyle(.plain)
        .task(id: autoPreviewLoadKey) {
            await loadPreviewAfterChatSettlesIfNeeded()
        }
        .fullScreenCover(item: $previewRequest) { request in
            AssistantWorkspaceImagePreviewScreen(
                reference: request.reference,
                currentWorkingDirectory: request.currentWorkingDirectory,
                initialPayload: request.initialPayload,
                onDismiss: { previewRequest = nil }
            )
        }
    }

    @ViewBuilder
    private var content: some View {
        if let loadedPreview {
            loadedImage(loadedPreview)
        } else {
            metadataCard
        }
    }

    private func loadedImage(_ payload: PreviewImagePayload) -> some View {
        Image(uiImage: payload.image)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: Self.maxWidth, alignment: .leading)
            .clipShape(RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
                    .stroke(Color.primary.opacity(0.06), lineWidth: 0.5)
            )
            .contentShape(RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous))
    }

    private var metadataCard: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(Color.accentColor.opacity(0.12))
                if isAutoLoadingPreview {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(Color.accentColor)
                } else {
                    Image(systemName: "photo")
                        .font(AppFont.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .frame(width: 32, height: 32)

            VStack(alignment: .leading, spacing: 2) {
                Text(reference.fileName.isEmpty ? "Generated image" : reference.fileName)
                    .font(AppFont.subheadline(weight: .semibold))
                    .foregroundStyle(.primary)
                Text(reference.path)
                    .font(AppFont.mono(.caption))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer(minLength: 0)

            Image(systemName: "arrow.up.left.and.arrow.down.right")
                .font(AppFont.system(size: 14, weight: .semibold))
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
                .fill(Color(.secondarySystemBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
                .stroke(Color.primary.opacity(0.06), lineWidth: 0.5)
        )
    }

    private func openPreview() {
        previewRequest = AssistantWorkspaceImagePreviewRequest(
            reference: reference,
            currentWorkingDirectory: currentWorkingDirectory,
            initialPayload: loadedPreview
        )
    }

    private var autoPreviewLoadKey: String {
        "\(reference.id)|\(codex.connectionPhase)"
    }

    private var canAutoLoadPreview: Bool {
        codex.connectionPhase == .connected
    }

    @MainActor
    private func loadPreviewAfterChatSettlesIfNeeded() async {
        guard canAutoLoadPreview,
              loadedPreview == nil,
              !isAutoLoadingPreview,
              !didAttemptAutoPreviewLoad else {
            return
        }

        do {
            // Give post-connect UI reconciliation a beat before starting image reads.
            try await Task.sleep(nanoseconds: 300_000_000)
            guard canAutoLoadPreview, loadedPreview == nil else { return }
            didAttemptAutoPreviewLoad = true
            isAutoLoadingPreview = true
            defer { isAutoLoadingPreview = false }
            loadedPreview = try await AssistantWorkspaceImagePreviewLoader.load(
                reference: reference,
                currentWorkingDirectory: currentWorkingDirectory,
                codex: codex
            )
        } catch {
            // Inline auto-load stays silent; the fullscreen sheet owns visible errors and retry.
        }
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

// ─── Thinking UI ────────────────────────────────────────────────────

// Centralizes the inline reasoning row so thinking-specific spacing, fonts, and
// disclosure behavior are easy to tweak without hunting through MessageRow.
// Kept as one flat struct (no sub-view nesting) to minimise per-cell view-tree
// depth inside the LazyVStack — extra struct layers cost allocation + diffing on
// every scroll frame.
private struct ThinkingSystemBlock: View {
    let messageID: String
    let isStreaming: Bool
    let thinkingText: String
    let thinkingContent: ThinkingDisclosureContent
    let activityPreview: String?

    init(
        messageID: String,
        isStreaming: Bool,
        thinkingText: String,
        thinkingContent: ThinkingDisclosureContent,
        activityPreview: String? = nil
    ) {
        self.messageID = messageID
        self.isStreaming = isStreaming
        self.thinkingText = thinkingText
        self.thinkingContent = thinkingContent
        self.activityPreview = activityPreview
    }

    var body: some View {
        Group {
            // Keep completed reasoning visible too; older builds showed thinking blocks
            // even after stream completion whenever content was present.
            if isStreaming || !thinkingText.isEmpty {
                if let activityPreview {
                    activityPreviewText(activityPreview)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    .padding(.vertical, 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else if thinkingText.isEmpty {
                    EmptyView()
                } else {
                    ThinkingDisclosureView(
                        messageID: messageID,
                        content: thinkingContent
                    )
                    .padding(.vertical, 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func activityPreviewText(_ preview: String) -> Text {
        let trimmed = preview.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return Text("") }

        let splitIndex = trimmed.firstIndex(of: " ")
        let leading: String
        let remainder: String

        if let splitIndex {
            leading = String(trimmed[..<splitIndex])
            remainder = String(trimmed[splitIndex...])
        } else {
            leading = trimmed
            remainder = ""
        }

        let capitalised = leading.prefix(1).uppercased() + leading.dropFirst()

        return Text(capitalised)
            .font(AppFont.caption(weight: .medium))
            .foregroundStyle(.secondary)
        +
        Text(remainder)
            .font(AppFont.caption())
            .foregroundStyle(.tertiary)
    }
}

// A single-pass gradient sweep that slides across the text it overlays.
private struct ShimmerMask: View {
    @State private var phase: CGFloat = -1

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            LinearGradient(
                stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .white.opacity(0.45), location: 0.4),
                    .init(color: .white.opacity(0.45), location: 0.6),
                    .init(color: .clear, location: 1),
                ],
                startPoint: .leading,
                endPoint: .trailing
            )
            .frame(width: w * 0.6)
            .offset(x: phase * w)
            .onAppear {
                withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: false)) {
                    phase = 1.4
                }
            }
        }
        .allowsHitTesting(false)
    }
}

// Owns disclosure state for compact reasoning summaries without invalidating MessageRow.
private struct ThinkingDisclosureView: View {
    let messageID: String
    let content: ThinkingDisclosureContent

    @State private var expandedSectionIDs: Set<String> = []

    var body: some View {
        return VStack(alignment: .leading, spacing: 8) {
            if content.showsDisclosure {
                ForEach(content.sections) { section in
                    sectionDisclosure(section)
                }
            } else if !content.fallbackText.isEmpty {
                detailText(content.fallbackText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: messageID) { _, _ in
            expandedSectionIDs.removeAll()
        }
    }

    private func sectionDisclosure(_ section: ThinkingDisclosureSection) -> some View {
        let isExpanded = expandedSectionIDs.contains(section.id)
        let hasDetail = !section.detail.isEmpty

        return VStack(alignment: .leading, spacing: 6) {
            Button {
                guard hasDetail else { return }
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    if isExpanded {
                        expandedSectionIDs.remove(section.id)
                    } else {
                        expandedSectionIDs.insert(section.id)
                    }
                }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(AppFont.system(size: 10, weight: .semibold))
                        .foregroundStyle(hasDetail ? .secondary : .tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .frame(width: 10)

                    Text(section.title)
                        .font(AppFont.caption(weight: .semibold))
                        .foregroundStyle(.secondary.opacity(0.95))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded, hasDetail {
                detailText(section.detail)
                    .padding(.leading, 18)
                    .transition(.opacity.combined(with: .scale(scale: 1, anchor: .top)))
                    .clipped()
            }
        }
    }

    private func detailText(_ value: String) -> some View {
        Text(runtimeMarkdownText(value))
            .font(AppFont.caption())
            .lineSpacing(2)
            .fontWeight(.regular)
            .foregroundStyle(.secondary.opacity(0.85))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // Parse folded reasoning as inline markdown without routing through LocalizedStringKey interpolation.
    private func runtimeMarkdownText(_ value: String) -> AttributedString {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        return (try? AttributedString(markdown: value, options: options)) ?? AttributedString(value)
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

private struct AssistantWorkspaceImagePreviewRequest: Identifiable {
    let id = UUID()
    let reference: AssistantMarkdownImageReference
    let currentWorkingDirectory: String?
    let initialPayload: PreviewImagePayload?
}

struct WorkspaceFilePreviewRequest: Identifiable, Equatable {
    let path: String
    let currentWorkingDirectory: String?

    var id: String {
        "\(currentWorkingDirectory ?? "")|\(path)"
    }
}

private enum WorkspaceLinkedFilePreviewKind {
    case imageFirst
    case textFirst
    case svg
}

enum WorkspaceFileLinkResolver {
    private static let textFileExtensions: Set<String> = [
        "c", "cc", "cpp", "css", "go", "h", "html", "java", "js", "json", "jsx",
        "kt", "m", "md", "mm", "py", "rb", "rs", "sh", "swift", "toml", "ts",
        "tsx", "txt", "xml", "yaml", "yml"
    ]
    private static let imageFileExtensions: Set<String> = [
        "gif", "heic", "heif", "jpeg", "jpg", "png", "webp"
    ]
    // SVG is text on disk but previews best as rendered artwork, so it gets its own kind.
    private static let svgFileExtension = "svg"
    private static let extensionlessFileNames: Set<String> = [
        "dockerfile", "gemfile", "makefile", "podfile"
    ]

    static func localPath(from url: URL) -> String? {
        if url.isFileURL {
            return normalizedPath(url.path)
        }

        guard url.scheme == nil else {
            return nil
        }

        let rawValue = url.absoluteString.removingPercentEncoding ?? url.absoluteString
        return normalizedPath(rawValue)
    }

    fileprivate static func preferredPreviewKind(for path: String) -> WorkspaceLinkedFilePreviewKind {
        let fileExtension = (path as NSString).pathExtension.lowercased()
        if fileExtension == svgFileExtension {
            return .svg
        }
        return textFileExtensions.contains(fileExtension) ? .textFirst : .imageFirst
    }

    private static func normalizedPath(_ value: String) -> String? {
        let trimmed = stripLineSuffix(from: stripFragmentAndQuery(from: value))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              !trimmed.hasPrefix("#"),
              !trimmed.contains("\n"),
              !trimmed.contains("\r") else {
            return nil
        }
        guard isLocalPathCandidate(trimmed) else {
            return nil
        }
        return trimmed
    }

    private static func isLocalPathCandidate(_ value: String) -> Bool {
        if value.hasPrefix("/") || value.hasPrefix("./") || value.hasPrefix("../") {
            return true
        }
        guard !looksLikeSchemeLessWebURL(value) else {
            return false
        }

        let fileName = (value as NSString).lastPathComponent.lowercased()
        let fileExtension = (value as NSString).pathExtension.lowercased()
        return extensionlessFileNames.contains(fileName)
            || textFileExtensions.contains(fileExtension)
            || imageFileExtensions.contains(fileExtension)
            || fileExtension == svgFileExtension
    }

    private static func looksLikeSchemeLessWebURL(_ value: String) -> Bool {
        guard value.contains("/") else {
            return false
        }
        guard let firstComponent = value.split(separator: "/", maxSplits: 1).first else {
            return false
        }
        return firstComponent.contains(".")
            && !firstComponent.hasPrefix(".")
            && !firstComponent.hasSuffix(".")
    }

    private static func stripFragmentAndQuery(from value: String) -> String {
        guard let boundary = value.firstIndex(where: { $0 == "#" || $0 == "?" }) else {
            return value
        }
        return String(value[..<boundary])
    }

    private static func stripLineSuffix(from value: String) -> String {
        var normalized = value
        if let range = normalized.range(of: #":\d+(?::\d+)?$"#, options: .regularExpression) {
            normalized.removeSubrange(range)
        }
        return normalized
    }
}

private struct WorkspacePreviewChromeButton: View {
    let systemName: String
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            action()
        } label: {
            Image(systemName: systemName)
                .font(AppFont.system(size: 17, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 38, height: 38)
                .adaptiveGlass(.regular, in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}

private struct WorkspacePreviewTitlePill: View {
    let title: String

    var body: some View {
        Text(title)
            .font(AppFont.subheadline(weight: .semibold))
            .foregroundStyle(.primary)
            .lineLimit(1)
            .padding(.horizontal, 14)
            .frame(height: 38)
            .adaptiveGlass(.regular, in: Capsule())
    }
}

private struct WorkspacePreviewRetryButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("Retry", systemImage: "arrow.clockwise")
                .font(AppFont.subheadline(weight: .semibold))
                .padding(.horizontal, 16)
                .frame(height: 40)
                .adaptiveGlass(.regular, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

private struct WorkspaceSVGFilePreviewPayload: Equatable {
    let source: String
    let title: String
    let path: String
}

private enum WorkspaceLinkedFilePreviewPayload {
    case image(PreviewImagePayload)
    case text(WorkspaceTextFileReadResult)
    case svg(WorkspaceSVGFilePreviewPayload)
}

struct WorkspaceLinkedFilePreviewScreen: View {
    let request: WorkspaceFilePreviewRequest
    let onDismiss: () -> Void

    @Environment(CodexService.self) private var codex
    @State private var isLoading = false
    @State private var payload: WorkspaceLinkedFilePreviewPayload?
    @State private var errorMessage: String?

    var body: some View {
        Group {
            switch payload {
            case .image(let imagePayload):
                ZoomableImagePreviewScreen(payload: imagePayload, onDismiss: onDismiss)
            case .text(let file):
                WorkspaceTextFileViewerScreen(file: file, onDismiss: onDismiss, onReload: {
                    Task { await loadPreview(force: true) }
                })
            case .svg(let svgPayload):
                WorkspaceSVGFilePreviewScreen(payload: svgPayload, onDismiss: onDismiss, onReload: {
                    Task { await loadPreview(force: true) }
                })
            case nil:
                loadingOrErrorScreen
            }
        }
        .task(id: request.id) {
            await loadPreview()
        }
    }

    private var loadingOrErrorScreen: some View {
        ZStack(alignment: .top) {
            Color(.systemBackground)
                .ignoresSafeArea()

            VStack(spacing: 16) {
                Spacer(minLength: 0)

                if isLoading || errorMessage == nil {
                    ProgressView()
                        .controlSize(.large)
                    Text("Loading file")
                        .font(AppFont.subheadline(weight: .semibold))
                } else {
                    Image(systemName: "doc.text")
                        .font(AppFont.system(size: 32, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Text(fileName)
                        .font(AppFont.subheadline(weight: .semibold))
                        .multilineTextAlignment(.center)
                    if let errorMessage {
                        Text(errorMessage)
                            .font(AppFont.caption())
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .lineLimit(5)
                    }
                    WorkspacePreviewRetryButton {
                        Task { await loadPreview(force: true) }
                    }
                }

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 28)

            previewTopBar
                .padding(.horizontal, 18)
                .padding(.top, 18)
        }
    }

    private var previewTopBar: some View {
        HStack(spacing: 14) {
            WorkspacePreviewChromeButton(systemName: "xmark", accessibilityLabel: "Close file preview") {
                onDismiss()
            }

            WorkspacePreviewTitlePill(title: fileName)

            Spacer(minLength: 0)
        }
    }

    private var fileName: String {
        let basename = (request.path as NSString).lastPathComponent
        return basename.isEmpty ? "File" : basename
    }

    @MainActor
    private func loadPreview(force: Bool = false) async {
        guard !isLoading else { return }
        if payload != nil, !force {
            return
        }

        isLoading = true
        errorMessage = nil
        if force {
            payload = nil
        }
        defer { isLoading = false }

        switch WorkspaceFileLinkResolver.preferredPreviewKind(for: request.path) {
        case .imageFirst:
            await loadImageThenText(force: force)
        case .textFirst:
            await loadTextThenImage(force: force)
        case .svg:
            await loadSVGThenText()
        }
    }

    @MainActor
    private func loadSVGThenText() async {
        do {
            payload = .svg(try await loadSVGPayload())
            return
        } catch {
            // Fall back to the raw markup if the file can't be rendered as artwork.
            let svgError = error
            do {
                payload = .text(try await loadTextPayload())
            } catch {
                errorMessage = combinedPreviewError(primary: svgError, fallback: error)
            }
        }
    }

    @MainActor
    private func loadImageThenText(force: Bool) async {
        do {
            payload = .image(try await loadImagePayload(force: force))
            return
        } catch {
            let imageError = error
            do {
                payload = .text(try await loadTextPayload())
            } catch {
                errorMessage = combinedPreviewError(primary: imageError, fallback: error)
            }
        }
    }

    @MainActor
    private func loadTextThenImage(force: Bool) async {
        do {
            payload = .text(try await loadTextPayload())
            return
        } catch {
            let textError = error
            do {
                payload = .image(try await loadImagePayload(force: force))
            } catch {
                errorMessage = combinedPreviewError(primary: textError, fallback: error)
            }
        }
    }

    @MainActor
    private func loadImagePayload(force: Bool) async throws -> PreviewImagePayload {
        let imageReference = AssistantMarkdownImageReference(
            path: request.path,
            altText: fileName,
            occurrenceIndex: 0
        )
        return try await AssistantWorkspaceImagePreviewLoader.load(
            reference: imageReference,
            currentWorkingDirectory: request.currentWorkingDirectory,
            codex: codex,
            force: force
        )
    }

    @MainActor
    private func loadTextPayload() async throws -> WorkspaceTextFileReadResult {
        try await codex.readWorkspaceTextFile(
            path: request.path,
            cwd: request.currentWorkingDirectory
        )
    }

    @MainActor
    private func loadSVGPayload() async throws -> WorkspaceSVGFilePreviewPayload {
        let file = try await loadTextPayload()
        let source = file.content ?? ""
        guard !source.isEmpty else {
            throw CodexServiceError.invalidResponse("SVG preview response did not include readable SVG markup.")
        }
        return WorkspaceSVGFilePreviewPayload(source: source, title: fileName, path: request.path)
    }

    private func combinedPreviewError(primary: Error, fallback: Error) -> String {
        let primaryMessage = primary.localizedDescription
        let fallbackMessage = fallback.localizedDescription
        guard !primaryMessage.isEmpty else { return fallbackMessage }
        guard !fallbackMessage.isEmpty, fallbackMessage != primaryMessage else { return primaryMessage }
        return "\(primaryMessage)\n\(fallbackMessage)"
    }
}

private struct WorkspaceSVGFilePreviewScreen: View {
    let payload: WorkspaceSVGFilePreviewPayload
    let onDismiss: () -> Void
    let onReload: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack(alignment: .top) {
            Color(.systemBackground)
                .ignoresSafeArea()

            WorkspaceSVGWebView(source: payload.source, colorScheme: colorScheme)
                .ignoresSafeArea()

            topBar
                .padding(.horizontal, 18)
                .padding(.top, 18)
                .zIndex(2)
        }
    }

    private var topBar: some View {
        HStack(spacing: 14) {
            WorkspacePreviewChromeButton(systemName: "xmark", accessibilityLabel: "Close SVG preview") {
                onDismiss()
            }

            WorkspacePreviewTitlePill(title: payload.title.isEmpty ? "SVG" : payload.title)

            Spacer(minLength: 0)

            WorkspacePreviewChromeButton(systemName: "arrow.clockwise", accessibilityLabel: "Reload SVG preview") {
                onReload()
            }
        }
    }
}

private struct WorkspaceTextFileViewerScreen: View {
    let file: WorkspaceTextFileReadResult
    let onDismiss: () -> Void
    let onReload: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var isShowingCopiedConfirmation = false

    private var content: String {
        file.content ?? ""
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                fileMetadataHeader
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .padding(.bottom, 8)
                // Runestone provides syntax highlighting, line numbers, selection, and
                // its own scrolling, so it is not wrapped in a SwiftUI ScrollView.
                WorkspaceRunestoneCodeFileView(
                    content: content,
                    fileName: file.fileName,
                    colorScheme: colorScheme
                )
            }
            .background(Color(.systemBackground))
            .navigationTitle(file.fileName.isEmpty ? "File" : file.fileName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { onDismiss() }
                }
                ToolbarItemGroup(placement: .confirmationAction) {
                    Button {
                        onReload()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Reload file")

                    Button {
                        UIPasteboard.general.string = content
                        withAnimation(.easeInOut(duration: 0.18)) {
                            isShowingCopiedConfirmation = true
                        }
                    } label: {
                        Image(systemName: isShowingCopiedConfirmation ? "checkmark" : "doc.on.doc")
                    }
                    .accessibilityLabel("Copy file contents")
                }
            }
        }
    }

    private var fileMetadataHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(file.path)
                .font(AppFont.mono(.caption))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .truncationMode(.middle)
            Text(metadataSummary)
                .font(AppFont.caption())
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 4)
    }

    private var metadataSummary: String {
        var parts = [ByteCountFormatter.string(fromByteCount: Int64(file.byteLength), countStyle: .file)]
        if let lineCount = file.lineCount {
            parts.append("\(lineCount) line\(lineCount == 1 ? "" : "s")")
        }
        parts.append(file.encoding.uppercased())
        return parts.joined(separator: " | ")
    }
}

private struct AssistantWorkspaceImagePreviewScreen: View {
    let reference: AssistantMarkdownImageReference
    let currentWorkingDirectory: String?
    let onDismiss: () -> Void

    @Environment(CodexService.self) private var codex
    @State private var isLoading = false
    @State private var payload: PreviewImagePayload?
    @State private var errorMessage: String?

    init(
        reference: AssistantMarkdownImageReference,
        currentWorkingDirectory: String?,
        initialPayload: PreviewImagePayload? = nil,
        onDismiss: @escaping () -> Void
    ) {
        self.reference = reference
        self.currentWorkingDirectory = currentWorkingDirectory
        self.onDismiss = onDismiss
        _payload = State(initialValue: initialPayload)
    }

    var body: some View {
        Group {
            if let payload {
                ZoomableImagePreviewScreen(
                    payload: payload,
                    onDismiss: onDismiss
                )
            } else {
                loadingOrErrorScreen
            }
        }
        .task(id: reference.path) {
            await loadPreview()
        }
    }

    private var loadingOrErrorScreen: some View {
        ZStack(alignment: .top) {
            Color(.systemBackground)
                .ignoresSafeArea()

            LinearGradient(
                colors: [
                    Color(.secondarySystemBackground).opacity(0.7),
                    Color(.systemBackground)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 18) {
                Spacer(minLength: 0)

                if isLoading || errorMessage == nil {
                    ProgressView()
                        .controlSize(.large)
                    Text(reference.fileName.isEmpty ? "Loading image" : reference.fileName)
                        .font(AppFont.subheadline(weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                } else {
                    Image(systemName: "photo")
                        .font(AppFont.system(size: 32, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Text(reference.fileName.isEmpty ? "Image unavailable" : reference.fileName)
                        .font(AppFont.subheadline(weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                    if let errorMessage {
                        Text(errorMessage)
                            .font(AppFont.caption())
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .lineLimit(4)
                    }
                    Button {
                        Task { await loadPreview(force: true) }
                    } label: {
                        Label("Retry", systemImage: "arrow.clockwise")
                            .font(AppFont.subheadline(weight: .semibold))
                            .padding(.horizontal, 16)
                            .frame(height: 40)
                            .adaptiveGlass(.regular, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 28)

            topBar
                .padding(.horizontal, 18)
                .padding(.top, 18)
        }
    }

    private var topBar: some View {
        HStack(spacing: 14) {
            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(AppFont.system(size: 17, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 38, height: 38)
                    .adaptiveGlass(.regular, in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)

            if !reference.fileName.isEmpty {
                Text(reference.fileName)
                    .font(AppFont.subheadline(weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .padding(.horizontal, 14)
                    .frame(height: 38)
                    .adaptiveGlass(.regular, in: Capsule())
            }

            Spacer(minLength: 0)
        }
    }

    @MainActor
    private func loadPreview(force: Bool = false) async {
        guard !isLoading else { return }
        if payload != nil, !force {
            return
        }

        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            payload = try await AssistantWorkspaceImagePreviewLoader.load(
                reference: reference,
                currentWorkingDirectory: currentWorkingDirectory,
                codex: codex,
                force: force
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private enum AssistantWorkspaceImagePreviewLoader {
    @MainActor
    static func load(
        reference: AssistantMarkdownImageReference,
        currentWorkingDirectory: String?,
        codex: CodexService,
        force: Bool = false
    ) async throws -> PreviewImagePayload {
        let cachedPreview = await WorkspaceImagePreviewCache.shared.cachedPreview(forPath: reference.path)
        let result = try await codex.readWorkspaceImage(
            path: reference.path,
            cwd: currentWorkingDirectory,
            cachedMetadata: force ? nil : cachedPreview?.metadata
        )
        if result.isNotModified, let cachedPreview {
            return PreviewImagePayload(
                image: cachedPreview.payload.image,
                title: cachedPreview.metadata.fileName.isEmpty ? reference.fileName : cachedPreview.metadata.fileName
            )
        }

        let decodedImage = try await WorkspaceImagePreviewCache.shared.preview(for: result)
        return PreviewImagePayload(
            image: decodedImage.image,
            title: result.fileName.isEmpty ? reference.fileName : result.fileName
        )
    }
}

private struct CachedWorkspaceImagePreview: Sendable {
    let metadata: WorkspaceImageMetadata
    let payload: CommandImagePreviewPayload
}

private final class CommandImagePreviewPayload: @unchecked Sendable {
    let image: UIImage

    nonisolated init(image: UIImage) {
        self.image = image
    }

    nonisolated var estimatedMemoryCost: Int {
        guard let cgImage = image.cgImage else {
            return 1
        }
        return max(cgImage.bytesPerRow * cgImage.height, 1)
    }
}

private actor WorkspaceImagePreviewCache {
    static let shared = WorkspaceImagePreviewCache()

    private let cache = NSCache<NSString, CommandImagePreviewPayload>()
    private var inFlightPreviews: [String: Task<CommandImagePreviewPayload, Error>] = [:]
    private var latestMetadataByPath: [String: WorkspaceImageMetadata] = [:]
    private var latestMetadataAccessOrder: [String] = []

    private init() {
        cache.countLimit = 24
        cache.totalCostLimit = 80 * 1024 * 1024
    }

    func cachedPreview(forPath path: String) -> CachedWorkspaceImagePreview? {
        guard let metadata = latestMetadataByPath[path],
              let payload = cache.object(forKey: cacheKey(for: metadata) as NSString) else {
            return nil
        }
        latestMetadataAccessOrder.removeAll { $0 == path }
        latestMetadataAccessOrder.append(path)
        return CachedWorkspaceImagePreview(metadata: metadata, payload: payload)
    }

    func preview(for result: WorkspaceImageReadResult) async throws -> CommandImagePreviewPayload {
        let key = cacheKey(for: result.metadata)
        let nsKey = key as NSString
        if let cached = cache.object(forKey: nsKey) {
            return cached
        }
        if let task = inFlightPreviews[key] {
            return try await task.value
        }

        guard let data = result.data else {
            throw CodexServiceError.invalidResponse("Cached image preview was unavailable.")
        }
        let task = Task(priority: .userInitiated) {
            try await CommandImagePreviewDecoder.decode(data)
        }
        inFlightPreviews[key] = task
        defer { inFlightPreviews[key] = nil }

        let decodedImage = try await task.value
        cache.setObject(decodedImage, forKey: nsKey, cost: decodedImage.estimatedMemoryCost)
        rememberMetadata(result.metadata)
        return decodedImage
    }

    private func cacheKey(for metadata: WorkspaceImageMetadata) -> String {
        let mtimeMs = metadata.mtimeMs.map { String($0.bitPattern) } ?? "missing"
        let previewMax = metadata.previewMaxPixelDimension.map(String.init) ?? "original"
        return "\(metadata.path)|\(metadata.byteLength)|\(mtimeMs)|\(previewMax)"
    }

    private func rememberMetadata(_ metadata: WorkspaceImageMetadata) {
        latestMetadataByPath[metadata.path] = metadata
        latestMetadataAccessOrder.removeAll { $0 == metadata.path }
        latestMetadataAccessOrder.append(metadata.path)

        while latestMetadataAccessOrder.count > 64, let evictedPath = latestMetadataAccessOrder.first {
            latestMetadataAccessOrder.removeFirst()
            latestMetadataByPath[evictedPath] = nil
        }
    }
}

private enum CommandImagePreviewDecoder {
    nonisolated private static let maxPreviewPixelDimension = 2_400

    // Downsamples and prepares the preview off the main actor before presenting it.
    static func decode(_ data: Data) async throws -> CommandImagePreviewPayload {
        try await Task.detached(priority: .userInitiated) {
            let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
            guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else {
                throw CodexServiceError.invalidResponse("The file is not a readable image.")
            }

            let thumbnailOptions = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPreviewPixelDimension,
            ] as CFDictionary

            if let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions) {
                return CommandImagePreviewPayload(image: UIImage(cgImage: cgImage))
            }

            guard let image = UIImage(data: data) else {
                throw CodexServiceError.invalidResponse("The file is not a readable image.")
            }
            return CommandImagePreviewPayload(image: image.preparingForDisplay() ?? image)
        }.value
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

private struct TimelineSystemBlockPreviewSurface<Content: View>: View {
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
struct ThinkingSystemBlockCompactPreviewHost: View {
    var body: some View {
        TimelineSystemBlockPreviewSurface {
            ThinkingSystemBlock(
                messageID: "preview-thinking-compact",
                isStreaming: true,
                thinkingText: "running rg -n \"Thinking\" AgntMobile/AgntMobile/Views/Turn",
                thinkingContent: ThinkingDisclosureContent(sections: [], fallbackText: "")
            )
        }
    }
}

@MainActor
struct ThinkingSystemBlockDisclosurePreviewHost: View {
    var body: some View {
        TimelineSystemBlockPreviewSurface {
            ThinkingSystemBlock(
                messageID: "preview-thinking-disclosure",
                isStreaming: false,
                thinkingText: """
                **Tracing timeline rendering**
                The thinking row now lives in its own dedicated view so typography and spacing changes stay local.

                **Checking disclosure typography**
                The selected prose font should be used for the thinking label and section titles instead of monospace.
                """,
                thinkingContent: ThinkingDisclosureContent(
                    sections: [
                        ThinkingDisclosureSection(
                            id: "trace",
                            title: "Tracing timeline rendering",
                            detail: "The thinking row now lives in its own dedicated view so typography and spacing changes stay local."
                        ),
                        ThinkingDisclosureSection(
                            id: "type",
                            title: "Checking disclosure typography",
                            detail: "The selected prose font should be used for the thinking label and section titles instead of monospace."
                        ),
                    ],
                    fallbackText: ""
                )
            )
        }
    }
}

@MainActor
struct ThinkingSystemBlockRealResponsePreviewHost: View {
    private let rawThinkingText = """
    **Explored 1 file**
    Found the compact thinking block and isolated it into a dedicated view so the UI can be tuned in one place.

    **Checking typography**
    Removed italics and aligned the label with the selected prose font instead of monospace styling.

    **Polishing compact activity state**
    running rg -n "Thinking" AgntMobile/AgntMobile/Views/Turn
    """

    var body: some View {
        let parsed = ThinkingDisclosureParser.parse(from: rawThinkingText)

        return TimelineSystemBlockPreviewSurface {
            ThinkingSystemBlock(
                messageID: "preview-thinking-real-response",
                isStreaming: false,
                thinkingText: ThinkingDisclosureParser.normalizedThinkingContent(from: rawThinkingText),
                thinkingContent: parsed
            )
        }
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

#Preview("Thinking Block — Compact") {
    ThinkingSystemBlockCompactPreviewHost()
}

#Preview("Thinking Block — Disclosure") {
    ThinkingSystemBlockDisclosurePreviewHost()
}

#Preview("Thinking Block — Real Response") {
    ThinkingSystemBlockRealResponsePreviewHost()
}

#Preview("Tool Call Block") {
    ToolCallSystemBlockPreviewHost()
}
