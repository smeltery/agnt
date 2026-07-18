// FILE: TurnTimelineSupportViews.swift
// Purpose: Hosts row, accessory, and footer support views for TurnTimelineView.
// Layer: View Component
// Exports: TurnTimeline support views
// Depends on: SwiftUI, TurnTimelineRenderProjection, MessageRow

import SwiftUI

enum TurnTimelinePendingAssistantState {
    // The optimistic user row appears before the first assistant row; keep both
    // the thinking indicator and bottom anchor active during that short gap.
    static func isWaitingForAssistantResponse(
        shouldAnchorToAssistantResponse: Bool,
        messages: [CodexMessage]
    ) -> Bool {
        shouldAnchorToAssistantResponse
            && messages.last?.role == .user
    }

    static func shouldTrackScrollGeometry(
        shouldAnchorToAssistantResponse: Bool,
        autoScrollMode: TurnAutoScrollMode,
        isWaitingForAssistantResponse: Bool
    ) -> Bool {
        !shouldAnchorToAssistantResponse
            && autoScrollMode != .anchorAssistantResponse
            && !isWaitingForAssistantResponse
    }

    static func shouldShowIndicator(isRunStartingOrRunning: Bool) -> Bool {
        return isRunStartingOrRunning
    }
}

struct AssistantBlockAccessoryState: Equatable {
    let copyText: String?
    let showsRunningIndicator: Bool
    let allowsCopy: Bool
    let blockDiffText: String?
    let blockDiffEntries: [TurnFileChangeSummaryEntry]?
    let blockRevertPresentation: AssistantRevertPresentation?
    let blockRevertMessage: CodexMessage?

    init(
        copyText: String?,
        showsRunningIndicator: Bool,
        allowsCopy: Bool = false,
        blockDiffText: String? = nil,
        blockDiffEntries: [TurnFileChangeSummaryEntry]? = nil,
        blockRevertPresentation: AssistantRevertPresentation? = nil,
        blockRevertMessage: CodexMessage? = nil
    ) {
        self.copyText = copyText
        self.showsRunningIndicator = showsRunningIndicator
        self.allowsCopy = allowsCopy
        self.blockDiffText = blockDiffText
        self.blockDiffEntries = blockDiffEntries
        self.blockRevertPresentation = blockRevertPresentation
        self.blockRevertMessage = blockRevertMessage
    }

    func replacingCopyText(_ copyText: String?) -> AssistantBlockAccessoryState {
        AssistantBlockAccessoryState(
            copyText: copyText,
            showsRunningIndicator: showsRunningIndicator,
            allowsCopy: allowsCopy,
            blockDiffText: blockDiffText,
            blockDiffEntries: blockDiffEntries,
            blockRevertPresentation: blockRevertPresentation,
            blockRevertMessage: blockRevertMessage
        )
    }

    func replacingRunningIndicator(_ showsRunningIndicator: Bool) -> AssistantBlockAccessoryState {
        AssistantBlockAccessoryState(
            copyText: copyText,
            showsRunningIndicator: showsRunningIndicator,
            allowsCopy: allowsCopy,
            blockDiffText: blockDiffText,
            blockDiffEntries: blockDiffEntries,
            blockRevertPresentation: blockRevertPresentation,
            blockRevertMessage: blockRevertMessage
        )
    }

    func suppressingCopyAndRunningAccessory() -> AssistantBlockAccessoryState {
        AssistantBlockAccessoryState(
            copyText: nil,
            showsRunningIndicator: false,
            allowsCopy: false,
            blockDiffText: blockDiffText,
            blockDiffEntries: blockDiffEntries,
            blockRevertPresentation: blockRevertPresentation,
            blockRevertMessage: blockRevertMessage
        )
    }

    func mergingRehomedAccessoryState(_ state: AssistantBlockAccessoryState) -> AssistantBlockAccessoryState {
        AssistantBlockAccessoryState(
            copyText: copyText ?? state.copyText,
            showsRunningIndicator: showsRunningIndicator || state.showsRunningIndicator,
            allowsCopy: allowsCopy || state.allowsCopy,
            blockDiffText: blockDiffText ?? state.blockDiffText,
            blockDiffEntries: blockDiffEntries ?? state.blockDiffEntries,
            blockRevertPresentation: blockRevertPresentation ?? state.blockRevertPresentation,
            blockRevertMessage: blockRevertMessage ?? state.blockRevertMessage
        )
    }
}

enum TurnTimelineToolBurstAccessoryResolver {
    static func copyFooterState(
        for group: TurnTimelineToolBurstGroup,
        statesByMessageID: [String: AssistantBlockAccessoryState],
        suppressesRunningIndicator: Bool
    ) -> AssistantBlockAccessoryState? {
        guard let hostMessage = group.latestMessage,
              let state = statesByMessageID[hostMessage.id] else {
            return nil
        }

        let resolvedState = suppressesRunningIndicator
            ? state.replacingRunningIndicator(false)
            : state
        guard resolvedState.showsRunningIndicator
            || (resolvedState.allowsCopy && resolvedState.copyText != nil) else {
            return nil
        }
        return resolvedState
    }
}

struct TurnTimelineMessageRow: View {
    let message: CodexMessage
    let isRetryAvailable: Bool
    let cachedBlockInfoByMessageID: [String: AssistantBlockAccessoryState]
    let planSessionSource: CodexPlanSessionSource?
    let allowsAssistantPlanFallbackRecovery: Bool
    let completedTurnIDs: Set<String>
    let threadMessagesForPlanMatching: [CodexMessage]
    let currentWorkingDirectory: String?
    let planMatchingFingerprint: Int
    let newestStreamingMessageID: String?
    let autoScrollMode: TurnAutoScrollMode
    let showsGlobalRunningIndicator: Bool
    let movesCopyAndRunningToGroupFooter: Bool
    let onRetryUserMessage: (String) -> Void
    let onTapAssistantRevert: (CodexMessage) -> Void
    let onTapSubagent: (CodexSubagentThreadPresentation) -> Void

    var body: some View {
        MessageRow(
            message: message,
            isRetryAvailable: isRetryAvailable,
            onRetryUserMessage: onRetryUserMessage,
            assistantBlockAccessoryState: assistantBlockAccessoryState,
            planSessionSource: planSessionSource,
            allowsAssistantPlanFallbackRecovery: allowsAssistantPlanFallbackRecovery,
            assistantTurnCompleted: message.turnId.map(completedTurnIDs.contains) ?? false,
            threadMessagesForPlanMatching: threadMessagesForPlanMatching,
            currentWorkingDirectory: currentWorkingDirectory,
            planMatchingFingerprint: planMatchingFingerprint,
            showsStreamingAnimations: autoScrollMode == .followBottom
                && message.id == newestStreamingMessageID,
            assistantRevertAction: onTapAssistantRevert,
            subagentOpenAction: onTapSubagent
        )
        .equatable()
        .id(message.id)
    }

    private var assistantBlockAccessoryState: AssistantBlockAccessoryState? {
        let state = cachedBlockInfoByMessageID[message.id]
        let resolvedState = showsGlobalRunningIndicator
            ? state?.replacingRunningIndicator(false)
            : state
        return movesCopyAndRunningToGroupFooter
            ? resolvedState?.suppressingCopyAndRunningAccessory()
            : resolvedState
    }
}

private struct TurnTimelineToolBurstView: View {
    let group: TurnTimelineToolBurstGroup
    let isRetryAvailable: Bool
    let cachedBlockInfoByMessageID: [String: AssistantBlockAccessoryState]
    let planSessionSource: CodexPlanSessionSource?
    let allowsAssistantPlanFallbackRecovery: Bool
    let completedTurnIDs: Set<String>
    let threadMessagesForPlanMatching: [CodexMessage]
    let currentWorkingDirectory: String?
    let planMatchingFingerprint: Int
    let newestStreamingMessageID: String?
    let autoScrollMode: TurnAutoScrollMode
    let showsGlobalRunningIndicator: Bool
    let onRetryUserMessage: (String) -> Void
    let onTapAssistantRevert: (CodexMessage) -> Void
    let onTapSubagent: (CodexSubagentThreadPresentation) -> Void

    @State private var isExpanded = false

    private var summaryCountLabel: String {
        "+\(group.hiddenCount)"
    }

    private var summaryNounLabel: String {
        group.hiddenCount == 1 ? "tool call" : "tool calls"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if isExpanded {
                ForEach(group.overflowMessages) { message in
                    toolMessageRow(message)
                }
            }

            if let latestMessage = group.latestMessage {
                toolMessageRow(latestMessage)
            }

            if group.hiddenCount > 0 {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(AppFont.system(size: 10, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        (
                            Text(summaryCountLabel)
                                .font(AppFont.subheadline(weight: .medium))
                                .foregroundStyle(.secondary)
                            +
                            Text(" " + summaryNounLabel)
                                .font(AppFont.subheadline())
                                .foregroundStyle(.tertiary)
                        )
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }

            if let footerState = TurnTimelineToolBurstAccessoryResolver.copyFooterState(
                for: group,
                statesByMessageID: cachedBlockInfoByMessageID,
                suppressesRunningIndicator: showsGlobalRunningIndicator
            ) {
                CopyBlockButton(
                    text: footerState.allowsCopy ? footerState.copyText : nil,
                    isRunning: footerState.showsRunningIndicator
                )
            }
        }
    }

    private func toolMessageRow(_ message: CodexMessage) -> some View {
        TurnTimelineMessageRow(
            message: message,
            isRetryAvailable: isRetryAvailable,
            cachedBlockInfoByMessageID: cachedBlockInfoByMessageID,
            planSessionSource: planSessionSource,
            allowsAssistantPlanFallbackRecovery: allowsAssistantPlanFallbackRecovery,
            completedTurnIDs: completedTurnIDs,
            threadMessagesForPlanMatching: threadMessagesForPlanMatching,
            currentWorkingDirectory: currentWorkingDirectory,
            planMatchingFingerprint: planMatchingFingerprint,
            newestStreamingMessageID: newestStreamingMessageID,
            autoScrollMode: autoScrollMode,
            showsGlobalRunningIndicator: showsGlobalRunningIndicator,
            movesCopyAndRunningToGroupFooter: message.id == group.latestMessage?.id,
            onRetryUserMessage: onRetryUserMessage,
            onTapAssistantRevert: onTapAssistantRevert,
            onTapSubagent: onTapSubagent
        )
    }
}

private struct TurnTimelinePreviousMessagesView: View {
    let group: TurnTimelinePreviousMessagesGroup
    let isRetryAvailable: Bool
    let cachedBlockInfoByMessageID: [String: AssistantBlockAccessoryState]
    let planSessionSource: CodexPlanSessionSource?
    let allowsAssistantPlanFallbackRecovery: Bool
    let completedTurnIDs: Set<String>
    let threadMessagesForPlanMatching: [CodexMessage]
    let currentWorkingDirectory: String?
    let planMatchingFingerprint: Int
    let newestStreamingMessageID: String?
    let autoScrollMode: TurnAutoScrollMode
    let showsGlobalRunningIndicator: Bool
    let onRetryUserMessage: (String) -> Void
    let onTapAssistantRevert: (CodexMessage) -> Void
    let onTapSubagent: (CodexSubagentThreadPresentation) -> Void

    @State private var isExpanded = false

    private var title: String {
        group.hiddenCount == 1 ? "1 previous message" : "\(group.hiddenCount) previous messages"
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.secondary.opacity(0.18))
            .frame(height: 1)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Text(title)
                        .font(AppFont.body(weight: .regular))
                        .foregroundStyle(.secondary)
                    Image(systemName: "chevron.right")
                        .font(AppFont.system(size: 14, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(title)
            .accessibilityHint(isExpanded ? "Collapse previous messages" : "Expand previous messages")

            if isExpanded {
                ForEach(group.messages) { message in
                    TurnTimelineMessageRow(
                        message: message,
                        isRetryAvailable: isRetryAvailable,
                        cachedBlockInfoByMessageID: cachedBlockInfoByMessageID,
                        planSessionSource: planSessionSource,
                        allowsAssistantPlanFallbackRecovery: allowsAssistantPlanFallbackRecovery,
                        completedTurnIDs: completedTurnIDs,
                        threadMessagesForPlanMatching: threadMessagesForPlanMatching,
                        currentWorkingDirectory: currentWorkingDirectory,
                        planMatchingFingerprint: planMatchingFingerprint,
                        newestStreamingMessageID: newestStreamingMessageID,
                        autoScrollMode: autoScrollMode,
                        showsGlobalRunningIndicator: showsGlobalRunningIndicator,
                        movesCopyAndRunningToGroupFooter: false,
                        onRetryUserMessage: onRetryUserMessage,
                        onTapAssistantRevert: onTapAssistantRevert,
                        onTapSubagent: onTapSubagent
                    )
                }
            }

            divider
        }
        .id(group.id)
    }
}

struct TurnTimelineRowsSection: View {
    let shouldWarmRecentTailProgressively: Bool
    let hasEarlierMessages: Bool
    let renderItems: [TurnTimelineRenderItem]
    let showsPendingAssistantIndicator: Bool
    let isRetryAvailable: Bool
    let cachedBlockInfoByMessageID: [String: AssistantBlockAccessoryState]
    let planSessionSource: CodexPlanSessionSource?
    let allowsAssistantPlanFallbackRecovery: Bool
    let completedTurnIDs: Set<String>
    let threadMessagesForPlanMatching: [CodexMessage]
    let currentWorkingDirectory: String?
    let planMatchingFingerprint: Int
    let newestStreamingMessageID: String?
    let autoScrollMode: TurnAutoScrollMode
    let onRetryUserMessage: (String) -> Void
    let onTapAssistantRevert: (CodexMessage) -> Void
    let onTapSubagent: (CodexSubagentThreadPresentation) -> Void
    let onLoadEarlierMessages: () -> Void

    var body: some View {
        if shouldWarmRecentTailProgressively {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Loading recent messages...")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        if hasEarlierMessages {
            Button(action: onLoadEarlierMessages) {
                Text("Load earlier messages")
                    .font(AppFont.subheadline())
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
            }
            .buttonStyle(.plain)
        }

        ForEach(renderItems) { item in
            switch item {
            case .message(let message):
                TurnTimelineMessageRow(
                    message: message,
                    isRetryAvailable: isRetryAvailable,
                    cachedBlockInfoByMessageID: cachedBlockInfoByMessageID,
                    planSessionSource: planSessionSource,
                    allowsAssistantPlanFallbackRecovery: allowsAssistantPlanFallbackRecovery,
                    completedTurnIDs: completedTurnIDs,
                    threadMessagesForPlanMatching: threadMessagesForPlanMatching,
                    currentWorkingDirectory: currentWorkingDirectory,
                    planMatchingFingerprint: planMatchingFingerprint,
                    newestStreamingMessageID: newestStreamingMessageID,
                    autoScrollMode: autoScrollMode,
                    showsGlobalRunningIndicator: shouldShowPendingAssistantIndicator,
                    movesCopyAndRunningToGroupFooter: false,
                    onRetryUserMessage: onRetryUserMessage,
                    onTapAssistantRevert: onTapAssistantRevert,
                    onTapSubagent: onTapSubagent
                )
            case .toolBurst(let group):
                TurnTimelineToolBurstView(
                    group: group,
                    isRetryAvailable: isRetryAvailable,
                    cachedBlockInfoByMessageID: cachedBlockInfoByMessageID,
                    planSessionSource: planSessionSource,
                    allowsAssistantPlanFallbackRecovery: allowsAssistantPlanFallbackRecovery,
                    completedTurnIDs: completedTurnIDs,
                    threadMessagesForPlanMatching: threadMessagesForPlanMatching,
                    currentWorkingDirectory: currentWorkingDirectory,
                    planMatchingFingerprint: planMatchingFingerprint,
                    newestStreamingMessageID: newestStreamingMessageID,
                    autoScrollMode: autoScrollMode,
                    showsGlobalRunningIndicator: shouldShowPendingAssistantIndicator,
                    onRetryUserMessage: onRetryUserMessage,
                    onTapAssistantRevert: onTapAssistantRevert,
                    onTapSubagent: onTapSubagent
                )
            case .commandGroup(let group):
                TurnTimelineCommandGroupView(
                    group: group,
                    isRetryAvailable: isRetryAvailable,
                    cachedBlockInfoByMessageID: cachedBlockInfoByMessageID,
                    planSessionSource: planSessionSource,
                    allowsAssistantPlanFallbackRecovery: allowsAssistantPlanFallbackRecovery,
                    completedTurnIDs: completedTurnIDs,
                    threadMessagesForPlanMatching: threadMessagesForPlanMatching,
                    currentWorkingDirectory: currentWorkingDirectory,
                    planMatchingFingerprint: planMatchingFingerprint,
                    newestStreamingMessageID: newestStreamingMessageID,
                    autoScrollMode: autoScrollMode,
                    showsGlobalRunningIndicator: shouldShowPendingAssistantIndicator,
                    onRetryUserMessage: onRetryUserMessage,
                    onTapAssistantRevert: onTapAssistantRevert,
                    onTapSubagent: onTapSubagent
                )
            case .previousMessages(let group):
                TurnTimelinePreviousMessagesView(
                    group: group,
                    isRetryAvailable: isRetryAvailable,
                    cachedBlockInfoByMessageID: cachedBlockInfoByMessageID,
                    planSessionSource: planSessionSource,
                    allowsAssistantPlanFallbackRecovery: allowsAssistantPlanFallbackRecovery,
                    completedTurnIDs: completedTurnIDs,
                    threadMessagesForPlanMatching: threadMessagesForPlanMatching,
                    currentWorkingDirectory: currentWorkingDirectory,
                    planMatchingFingerprint: planMatchingFingerprint,
                    newestStreamingMessageID: newestStreamingMessageID,
                    autoScrollMode: autoScrollMode,
                    showsGlobalRunningIndicator: shouldShowPendingAssistantIndicator,
                    onRetryUserMessage: onRetryUserMessage,
                    onTapAssistantRevert: onTapAssistantRevert,
                    onTapSubagent: onTapSubagent
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)

        if shouldShowPendingAssistantIndicator {
            PendingAssistantIndicatorRow()
        }
    }

    private var shouldShowPendingAssistantIndicator: Bool {
        TurnTimelinePendingAssistantState.shouldShowIndicator(
            isRunStartingOrRunning: showsPendingAssistantIndicator
        )
    }
}

