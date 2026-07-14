// FILE: TurnTimelineView.swift
// Purpose: Renders timeline scrolling, bottom-anchor behavior and the footer container.
// Layer: View Component
// Exports: TurnTimelineView
// Depends on: SwiftUI, TurnTimelineRenderProjection, TurnTimelineReducer, MessageRow

import SwiftUI

struct TurnTimelineView<EmptyState: View, Composer: View>: View {
    @Environment(\.dynamicTypeSize) var dynamicTypeSize

    let threadID: String
    let messages: [CodexMessage]
    let timelineChangeToken: Int
    let activeTurnID: String?
    let isThreadRunning: Bool
    let isSendInFlight: Bool
    let latestTurnTerminalState: CodexTurnTerminalState?
    let completedTurnIDs: Set<String>
    let stoppedTurnIDs: Set<String>
    let assistantRevertStatesByMessageID: [String: AssistantRevertPresentation]
    let planSessionSource: CodexPlanSessionSource?
    let allowsAssistantPlanFallbackRecovery: Bool
    let threadMessagesForPlanMatching: [CodexMessage]
    let currentWorkingDirectory: String?
    let isRetryAvailable: Bool
    let errorMessage: String?
    let hidesErrorMessage: Bool
    let onReportError: (String) -> Void
    let onDismissError: () -> Void
    let hasRemoteEarlierMessages: Bool
    let hasLocallyProjectedEarlierMessages: Bool
    let usesPaginatedHistory: Bool
    let initialTurnsLoaded: Bool
    let isLoadingRemoteEarlierMessages: Bool
    let olderHistoryLoadErrorMessage: String?

    @Binding var shouldAnchorToAssistantResponse: Bool
    let isComposerFocused: Bool
    let isComposerAutocompletePresented: Bool

    let onRetryUserMessage: (String) -> Void
    let onTapAssistantRevert: (CodexMessage) -> Void
    let onTapSubagent: (CodexSubagentThreadPresentation) -> Void
    let onRevealEarlierMessages: (Int) -> Void
    let onLoadRemoteEarlierMessages: () -> Void
    let onRetryEarlierMessages: (@escaping () -> Void) -> Void
    let onTapOutsideComposer: () -> Void
    @ViewBuilder let emptyState: () -> EmptyState
    @ViewBuilder let composer: () -> Composer

    let scrollBottomAnchorID = "turn-scroll-bottom-anchor"
    /// Number of messages to show per page.  Only the tail slice is rendered;
    /// scrolling to the top reveals a "Load earlier messages" button.
    static var pageSize: Int { 40 }
    /// Heavy-chat staged warmup is temporarily disabled until geometry settles reliably.
    static var initialWarmTailCount: Int { 0 }
    static var scrollToLatestButtonLift: CGFloat { 44 + 18 }

    @State var visibleTailCount: Int = pageSize
    @State var isScrolledToBottom = true
    @State var viewportHeight: CGFloat = 0
    // Cached per-render artifacts to avoid O(n) recomputation inside the body.
    @State var cachedBlockInfoByMessageID: [String: AssistantBlockAccessoryState] = [:]
    @State var cachedNewestStreamingMessageID: String? = nil
    @State var cachedRenderItems: [TurnTimelineRenderItem] = []
    @State var cachedRenderItemsInputKey: Int = 0
    @State var cachedRenderItemsShapeSignature: Int?
    @State var blockInfoInputKey: Int = 0
    @State var scrollSessionThreadID: String?
    @State var autoScrollMode: TurnAutoScrollMode = .followBottom
    @State var initialRecoverySnapPendingThreadID: String?
    @State var initialRecoverySnapTask: Task<Void, Never>?
    @State var followBottomScrollTask: Task<Void, Never>?
    @State var pendingAssistantBottomSnapTask: Task<Void, Never>?
    @State var progressiveTailRevealTask: Task<Void, Never>?
    @State var isProgressivelyRevealingRecentTail = false
    @State var isUserDraggingScroll = false
    @State var userScrollCooldownUntil: Date?
    @State var scrollGeometryCoalescer = ScrollGeometryCoalescer()
    @State var lastTimelineGeometryLogBucket: Int?
    @State var timelineChangeCoalescer = MainQueueUpdateCoalescer()

    var body: some View {
        if messages.isEmpty {
            // Keep new/empty chats static to avoid scroll indicators and inert scrolling.
            emptyTimelineState
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemBackground))
                .contentShape(Rectangle())
                .onTapGesture {
                    onTapOutsideComposer()
                }
                .simultaneousGesture(emptyStateKeyboardDismissGesture)
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    footer()
                }
                .onAppear {
                    beginScrollSessionIfNeeded()
                }
                .onChange(of: threadID) { _, _ in
                    beginScrollSessionIfNeeded(force: true)
                }
        } else {
            ScrollViewReader { proxy in
                GeometryReader { viewport in
                    let contentWidth = timelineContentWidth(for: viewport.size.width)
                    ScrollView(.vertical) {
                        VStack(spacing: 20) {
                            TurnTimelineRowsSection(
                                shouldWarmRecentTailProgressively: shouldWarmRecentTailProgressively,
                                hasEarlierMessages: hasEarlierMessages,
                                renderItems: visibleRenderItems,
                                showsPendingAssistantIndicator: isThreadRunning || isSendInFlight,
                                isRetryAvailable: isRetryAvailable,
                                cachedBlockInfoByMessageID: cachedBlockInfoByMessageID,
                                planSessionSource: planSessionSource,
                                allowsAssistantPlanFallbackRecovery: allowsAssistantPlanFallbackRecovery,
                                completedTurnIDs: completedTurnIDs,
                                threadMessagesForPlanMatching: threadMessagesForPlanMatching,
                                currentWorkingDirectory: currentWorkingDirectory,
                                planMatchingFingerprint: planMatchingFingerprint,
                                newestStreamingMessageID: cachedNewestStreamingMessageID,
                                autoScrollMode: autoScrollMode,
                                onRetryUserMessage: onRetryUserMessage,
                                onTapAssistantRevert: onTapAssistantRevert,
                                onTapSubagent: onTapSubagent,
                                onLoadEarlierMessages: handleLoadEarlierMessages
                            )
                        }
                        // SwiftUI can otherwise let a streaming text row report an
                        // over-wide ideal size, which makes the vertical timeline pan sideways.
                        .frame(width: contentWidth, alignment: .leading)
                        .padding(.horizontal, timelineHorizontalPadding)
                        .frame(width: viewport.size.width, alignment: .leading)
                        .clipped()
                        .background(VerticalScrollAxisGuard())
                        .padding(.top, 12)
                        .padding(.bottom, 12)

                        // Keep bottom anchor outside the message stack so it is always
                        // reachable by scrollTo regardless of VStack layout timing.
                        Color.clear
                            .frame(width: contentWidth, height: 1)
                            .padding(.horizontal, timelineHorizontalPadding)
                            .frame(width: viewport.size.width, alignment: .leading)
                            .clipped()
                            .id(scrollBottomAnchorID)
                            .allowsHitTesting(false)
                    }
                    .accessibilityIdentifier("turn.timeline.scrollview")
                    .background(Color(.systemBackground))
                    .overlay {
                        if shouldShowFullTimelineLoader {
                            timelineLoadingOverlay
                        }
                    }
                    .frame(width: viewport.size.width)
                    .defaultScrollAnchor(initialScrollAnchor, for: .initialOffset)
                    .defaultScrollAnchor(.bottom, for: .sizeChanges)
                    .scrollDismissesKeyboard(.interactively)
                    .simultaneousGesture(
                        TapGesture().onEnded {
                            onTapOutsideComposer()
                        }
                    )
                    // Track real scroll phases instead of layering a competing drag gesture on top.
                    .onScrollPhaseChange { oldPhase, newPhase in
                        debugTimelineLog("scroll phase changed old=\(String(describing: oldPhase)) new=\(String(describing: newPhase))")
                        handleScrollPhaseChange(from: oldPhase, to: newPhase)
                    }
                    .onScrollGeometryChange(for: ScrollBottomGeometry.self) { geometry in
                        let vh = geometry.visibleRect.height
                        let isAtBottom: Bool
                        if geometry.contentSize.height <= 0 || vh <= 0 {
                            isAtBottom = true
                        } else if geometry.contentSize.height <= vh {
                            isAtBottom = true
                        } else {
                            isAtBottom = geometry.visibleRect.maxY
                                >= geometry.contentSize.height - TurnScrollStateTracker.bottomThreshold
                        }
                        return ScrollBottomGeometry(
                            isAtBottom: isAtBottom,
                            viewportHeight: vh,
                            contentHeight: geometry.contentSize.height
                        )
                    } action: { old, new in
                        // New sends suppress geometry callbacks while waiting for the assistant
                        // anchor so the optimistic user row is not snapped around mid-resume.
                        guard shouldTrackScrollGeometry else { return }
                        logTimelineGeometryChangeIfNeeded(old: old, new: new)
                        // Coalesce into a single commit per runloop turn so SwiftUI
                        // sees at most one @State mutation instead of several per frame.
                        scrollGeometryCoalescer.pending = (old, new)
                        guard !scrollGeometryCoalescer.isScheduled else { return }
                        scrollGeometryCoalescer.isScheduled = true
                        debugTimelineLog("geometry change scheduled for coalesced apply")
                        DispatchQueue.main.async {
                            scrollGeometryCoalescer.isScheduled = false
                            guard let pending = scrollGeometryCoalescer.pending else { return }
                            scrollGeometryCoalescer.pending = nil
                            applyScrollGeometryUpdate(
                                old: pending.old,
                                new: pending.new,
                                using: proxy
                            )
                        }
                    }
                    // Timeline mutations still drive block-info refresh and assistant anchoring,
                    // but geometry decides when follow-bottom should actually fire.
                    .onChange(of: timelineChangeToken) { _, _ in
                        debugTimelineLog(
                            "timelineChangeToken changed token=\(timelineChangeToken) "
                                + "messageCount=\(messages.count) visibleTail=\(visibleTailCount)"
                        )
                        timelineChangeCoalescer.schedule {
                            recomputeRenderItemsIfNeeded()
                            recomputeBlockInfoIfNeeded()
                            handleTimelineMutation(using: proxy)
                        }
                    }
                    .onChange(of: isThreadRunning) { _, _ in
                        debugTimelineLog("isThreadRunning changed value=\(isThreadRunning)")
                        // Run-state changes alter the sticky pending row and bottom inset before
                        // the first assistant item exists, so treat them like a timeline mutation.
                        DispatchQueue.main.async {
                            recomputeRenderItemsIfNeeded()
                            recomputeBlockInfoIfNeeded()
                            handleTimelineMutation(using: proxy)
                        }
                    }
                    .onChange(of: isSendInFlight) { _, _ in
                        debugTimelineLog("isSendInFlight changed value=\(isSendInFlight)")
                        // Sending mode is the optimistic-user-row gap between tap and turn/start.
                        // Re-run normal mutation handling so the row is measured while still pending.
                        DispatchQueue.main.async {
                            recomputeRenderItemsIfNeeded()
                            recomputeBlockInfoIfNeeded()
                            handleTimelineMutation(using: proxy)
                        }
                    }
                    .onChange(of: visibleMessagesBoundarySignature) { _, _ in
                        debugTimelineLog(
                            "visible messages changed token=\(timelineChangeToken) "
                                + "messageCount=\(messages.count) visibleTail=\(visibleTailCount)"
                        )
                        DispatchQueue.main.async {
                            recomputeRenderItemsIfNeeded()
                            recomputeBlockInfoIfNeeded()
                            scheduleProgressiveTailRevealIfNeeded()
                            handleTimelineMutation(using: proxy)
                        }
                    }
                    .onChange(of: threadID) { _, _ in
                        debugTimelineLog("threadID changed to=\(threadID)")
                        DispatchQueue.main.async {
                            beginScrollSessionIfNeeded(force: true)
                            recomputeRenderItemsIfNeeded()
                            recomputeBlockInfoIfNeeded()
                            scheduleProgressiveTailRevealIfNeeded()
                            handleTimelineMutation(using: proxy)
                        }
                    }
                    .onChange(of: activeTurnID) { _, _ in
                        debugTimelineLog("activeTurnID changed to=\(activeTurnID ?? "nil")")
                        DispatchQueue.main.async {
                            recomputeBlockInfoIfNeeded()
                            handleTimelineMutation(using: proxy)
                        }
                    }
                    .onChange(of: latestTurnTerminalState) { _, _ in
                        debugTimelineLog("latestTurnTerminalState changed to=\(String(describing: latestTurnTerminalState))")
                        recomputeBlockInfoIfNeeded()
                    }
                    .onChange(of: completedTurnIDs) { _, _ in
                        debugTimelineLog("completedTurnIDs changed count=\(completedTurnIDs.count)")
                        recomputeRenderItemsIfNeeded()
                        recomputeBlockInfoIfNeeded()
                    }
                    .onChange(of: stoppedTurnIDs) { _, _ in
                        debugTimelineLog("stoppedTurnIDs changed count=\(stoppedTurnIDs.count)")
                        recomputeBlockInfoIfNeeded()
                    }
                    .onChange(of: visibleTailCount) { _, _ in
                        debugTimelineLog("visibleTailCount changed value=\(visibleTailCount) totalMessages=\(messages.count)")
                        recomputeRenderItemsIfNeeded()
                        recomputeBlockInfoIfNeeded()
                    }
                    .onChange(of: shouldAnchorToAssistantResponse) { _, newValue in
                        if newValue {
                            autoScrollMode = .anchorAssistantResponse
                            handleTimelineMutation(using: proxy)
                        } else if autoScrollMode == .anchorAssistantResponse {
                            autoScrollMode = isScrolledToBottom ? .followBottom : .manual
                        }
                    }
                    // Keeps footer pinned to bottom without adding a solid spacer block above it.
                    .safeAreaInset(edge: .bottom, spacing: 0) {
                        footer(scrollToBottomAction: {
                            handleScrollToLatestButtonTap(using: proxy)
                        })
                    }
                    .onAppear {
                        debugTimelineLog("onAppear threadID=\(threadID) messageCount=\(messages.count)")
                        beginScrollSessionIfNeeded()
                        recomputeRenderItemsIfNeeded()
                        recomputeBlockInfoIfNeeded()
                        scheduleProgressiveTailRevealIfNeeded()
                        handleTimelineMutation(using: proxy)
                    }
                    .onDisappear {
                        debugTimelineLog("onDisappear threadID=\(threadID)")
                        StreamingUIInteractionMonitor.setScrollInteractionActive(false)
                        cancelScrollTasks()
                    }
                }
            }
        }
    }
}
