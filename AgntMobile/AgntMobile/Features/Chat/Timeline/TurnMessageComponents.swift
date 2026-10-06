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
    let presentationText = message.role == .assistant
        ? AssistantMemoryCitationParser.visibleText(in: message.text, isStreaming: message.isStreaming)
        : message.text
    let trimmedText = presentationText.trimmingCharacters(in: .whitespacesAndNewlines)
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

// ─── Message row ────────────────────────────────────────────────────

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
    @State var previewImage: PreviewImagePayload?
    @State var selectableTextSheet: SelectableMessageTextSheetState?
    @State var throttledAssistantDisplayText: String?
    @State var pendingAssistantDisplayText: String?
    @State var assistantDisplayUpdateTask: Task<Void, Never>?
    @State var assistantDisplaySyncTask: Task<Void, Never>?
    @AppStorage(UserBubbleColor.storageKey) var userBubbleColorRawValue = UserBubbleColor.defaultStoredRawValue
    @Environment(\.colorScheme) var colorScheme

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
    var displayText: String {
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



    var deliveryStatusText: String? {
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

    @Environment(\.inlineCommitAndPushAction) var inlineCommitAction
    @Environment(\.inlineCommitAndPushPhase) var inlineCommitAndPushPhase
    @State var isShowingBlockDiffSheet = false



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
