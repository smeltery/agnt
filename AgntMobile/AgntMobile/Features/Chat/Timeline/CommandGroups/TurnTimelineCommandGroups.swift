// FILE: TurnTimelineCommandGroups.swift
// Purpose: Renders grouped command-execution timeline disclosures.
// Layer: UI
// Exports: TurnTimelineCommandGroupView, TurnTimelineCommandGroupAccessoryResolver
// Depends on: SwiftUI, CodexMessage, TurnTimelineRenderProjection

import SwiftUI

enum TurnTimelineCommandGroupAccessoryResolver {
    static func copyFooterState(
        for group: TurnTimelineCommandGroup,
        statesByMessageID: [String: AssistantBlockAccessoryState],
        suppressesRunningIndicator: Bool
    ) -> AssistantBlockAccessoryState? {
        guard let hostMessage = group.accessoryHostMessage,
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

struct TurnTimelineCommandGroupView: View {
    let group: TurnTimelineCommandGroup
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
        var parts: [String] = []
        if group.commandCount > 0 {
            parts.append(group.commandCount == 1 ? "Ran 1 command" : "Ran \(group.commandCount) commands")
        }
        if group.toolCallCount > 0 {
            parts.append(group.toolCallCount == 1 ? "1 tool call" : "\(group.toolCallCount) tool calls")
        }
        if group.failedCommandCount > 0 {
            parts.append("\(group.failedCommandCount) failed")
        }
        if group.stoppedCommandCount > 0 {
            parts.append("\(group.stoppedCommandCount) stopped")
        }
        // Tool-only groups with no command rows would otherwise render an
        // empty disclosure button.
        return parts.isEmpty ? "Tool activity" : parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "terminal")
                        .font(AppFont.system(size: 17, weight: .regular))
                        .foregroundStyle(.secondary)
                    Text(title)
                        .font(AppFont.body(weight: .regular))
                        .foregroundStyle(.secondary)
                    Image(systemName: "chevron.right")
                        .font(AppFont.system(size: 13, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(title)
            .accessibilityHint(isExpanded ? "Collapse commands" : "Expand commands")

            if isExpanded {
                ForEach(group.orderedMessages) { message in
                    groupedMessageRow(message)
                }
            } else {
                ForEach(group.collapsedDetailMessages) { message in
                    groupedMessageRow(message)
                }
            }

            if let footerState = TurnTimelineCommandGroupAccessoryResolver.copyFooterState(
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
        .id(group.id)
    }

    private func groupedMessageRow(_ message: CodexMessage) -> some View {
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
            movesCopyAndRunningToGroupFooter: message.id == group.accessoryHostMessage?.id,
            onRetryUserMessage: onRetryUserMessage,
            onTapAssistantRevert: onTapAssistantRevert,
            onTapSubagent: onTapSubagent
        )
    }
}
