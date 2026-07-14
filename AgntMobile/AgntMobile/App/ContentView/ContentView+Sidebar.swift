// FILE: ContentView+Sidebar.swift
// Purpose: Extracted ContentView root-shell helpers.
// Layer: View

import SwiftUI
import UIKit

extension ContentView {
    // MARK: - Sidebar Geometry

    var sidebarVisible: Bool {
        isSidebarOpen || sidebarDragOffset > 0
    }

    var sidebarRevealWidth: CGFloat {
        sidebarRevealWidth(for: fallbackSidebarWidth)
    }

    var fallbackSidebarWidth: CGFloat {
        effectiveSidebarWidth(for: UIScreen.main.bounds.width)
    }

    func sidebarRevealWidth(for targetWidth: CGFloat) -> CGFloat {
        if isSidebarOpen {
            return max(0, targetWidth + sidebarDragOffset)
        } else {
            return max(0, sidebarDragOffset)
        }
    }

    func contentDimOpacity(for targetWidth: CGFloat) -> Double {
        guard targetWidth > 0 else { return 0 }
        let progress = min(1, sidebarRevealWidth(for: targetWidth) / targetWidth)
        return 0.08 * progress
    }

    // MARK: - Gestures

    var edgeDragGesture: some Gesture {
        DragGesture(minimumDistance: 15, coordinateSpace: .global)
            .onChanged { value in
                guard navigationPath.isEmpty else { return }
                guard !sidebarGestureAutoCommitted else { return }

                if !isSidebarOpen {
                    guard value.startLocation.x < sidebarOpenActivationWidth,
                          isOpeningSidebarGesture(value) else { return }
                    beginSidebarGestureDebugIfNeeded(kind: "open", startX: value.startLocation.x)
                    logSidebarGestureProgressIfNeeded(translation: value.translation.width)
                    guard value.translation.width >= sidebarSwipeCommitDistance else { return }
                    sidebarGestureAutoCommitted = true
                    debugSidebarLog(
                        "gesture #\(activeSidebarGestureDebugID ?? 0) auto-commit kind=open "
                            + "translation=\(Int(value.translation.width)) commit=\(Int(sidebarSwipeCommitDistance))"
                    )
                    finishGesture(open: true)
                } else {
                    guard isClosingSidebarGesture(value) else { return }
                    suppressSidebarSelectionBriefly()
                    beginSidebarGestureDebugIfNeeded(kind: "close", startX: value.startLocation.x)
                    logSidebarGestureProgressIfNeeded(translation: -value.translation.width)
                    guard -value.translation.width >= sidebarSwipeCommitDistance else { return }
                    sidebarGestureAutoCommitted = true
                    debugSidebarLog(
                        "gesture #\(activeSidebarGestureDebugID ?? 0) auto-commit kind=close "
                            + "translation=\(Int(-value.translation.width)) commit=\(Int(sidebarSwipeCommitDistance))"
                    )
                    finishGesture(open: false)
                }
            }
            .onEnded { value in
                guard navigationPath.isEmpty else { return }
                if sidebarGestureAutoCommitted {
                    sidebarGestureAutoCommitted = false
                    return
                }

                if !isSidebarOpen {
                    guard value.startLocation.x < sidebarOpenActivationWidth,
                          isOpeningSidebarGesture(value) else {
                        debugSidebarLog("gesture cancelled before open")
                        sidebarDragOffset = 0
                        sidebarGestureAutoCommitted = false
                        resetSidebarGestureDebug()
                        return
                    }
                    debugSidebarLog(
                        "gesture #\(activeSidebarGestureDebugID ?? 0) end kind=open "
                            + "translation=\(Int(value.translation.width)) predicted=\(Int(value.predictedEndTranslation.width)) "
                            + "commit=\(Int(sidebarSwipeCommitDistance)) decision=snap-close"
                    )
                    sidebarDragOffset = 0
                    resetSidebarGestureDebug()
                } else {
                    guard isClosingSidebarGesture(value) else {
                        debugSidebarLog("gesture cancelled before close")
                        sidebarDragOffset = 0
                        sidebarGestureAutoCommitted = false
                        resetSidebarGestureDebug()
                        return
                    }
                    suppressSidebarSelectionBriefly()
                    debugSidebarLog(
                        "gesture #\(activeSidebarGestureDebugID ?? 0) end kind=close "
                            + "translation=\(Int(-value.translation.width)) predicted=\(Int(-value.predictedEndTranslation.width)) "
                            + "commit=\(Int(sidebarSwipeCommitDistance)) decision=snap-open"
                    )
                    sidebarDragOffset = 0
                    resetSidebarGestureDebug()
                }
            }
    }

    // Keeps the sidebar swipe from claiming mostly vertical drags near the screen edge.
    func isOpeningSidebarGesture(_ value: DragGesture.Value) -> Bool {
        let horizontal = value.translation.width
        let vertical = value.translation.height
        return horizontal > 0 && abs(horizontal) > abs(vertical) * 1.15
    }

    func isClosingSidebarGesture(_ value: DragGesture.Value) -> Bool {
        let horizontal = value.translation.width
        let vertical = value.translation.height
        return horizontal < 0 && abs(horizontal) > abs(vertical) * 1.15
    }

    // MARK: - Sidebar Actions

    func toggleSidebar() {
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        let shouldOpenSidebar = !isSidebarOpen
        setSidebar(open: shouldOpenSidebar)
    }

    func closeSidebar() {
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        setSidebar(open: false)
    }

    func openThreadFromSidebar(_ thread: CodexThread) {
        guard !shouldSuppressSidebarSelection() else {
            debugSidebarLog("openThread suppressed by close swipe id=\(thread.id)")
            return
        }

        activeNewChatDraftRoute = nil
        isOpeningNewChatFromSidebar = false
        if isSidebarOpen || sidebarDragOffset > 0 {
            closeSidebar()
        }

        selectedThread = thread
        codex.activeThreadId = thread.id
        codex.markThreadAsViewed(thread.id)
        Task { @MainActor in
            do {
                let restoredThread = try await codex.restorePinnedThreadIfNeeded(threadId: thread.id)
                if let restoredThread {
                    selectedThread = restoredThread
                    codex.activeThreadId = restoredThread.id
                }
            } catch {
                codex.lastErrorMessage = codex.userFacingTurnErrorMessageForFooter(from: error)
            }

            codex.requestImmediateActiveThreadSync(threadId: thread.id)
        }
    }

    // MARK: - Home Screen quick actions

    func routePendingQuickActionIfNeeded() {
        if pendingQuickAction == nil {
            pendingQuickAction = AgntQuickActionCenter.consumePendingAction()
        }

        guard let action = pendingQuickAction else {
            return
        }

        // Shortcut callbacks can arrive before SwiftUI has resolved the size class.
        // Routing too early chooses drawer mode on iPhone and leaves the user at the sidebar root.
        guard horizontalSizeClass != nil else {
            return
        }

        pendingQuickAction = nil
        handleQuickAction(action)
    }

    func handleQuickAction(_ action: AgntQuickAction) {
        switch action {
        case .newChat:
            openNewChatDraftFromSidebar(source: .generalChat, preferredProjectPath: nil)
        case .thread(let threadId):
            if let thread = codex.threads.first(where: { $0.id == threadId && $0.syncState == .live }) {
                sidebarSelectionSuppressedUntil = nil
                openThreadFromSidebar(thread)
            } else {
                routeQuickActionThreadPlaceholder(threadId: threadId)
            }
        }
    }

    func routeQuickActionThreadPlaceholder(threadId: String) {
        let normalizedThreadId = threadId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedThreadId.isEmpty else {
            return
        }

        let thread = codex.threads.first(where: { $0.id == normalizedThreadId })
            ?? CodexThread(id: normalizedThreadId, title: CodexThread.defaultDisplayTitle)
        codex.upsertThread(thread)
        sidebarSelectionSuppressedUntil = nil
        openThreadFromSidebar(thread)
    }

    // Terminal can be opened from several surfaces with different cwd payloads;
    // replace the active terminal route instead of stacking near-identical pages.
    func openTerminal(preferredWorkingDirectory: String?) {
        if topNavigationRouteIsTerminal, !navigationPath.isEmpty {
            navigationPath.removeLast()
        }
        navigationPath.append(TerminalNavigationRoute(preferredWorkingDirectory: preferredWorkingDirectory))
        topNavigationRouteIsTerminal = true
    }

    // Prevents a close-swipe release from also activating whichever sidebar row was under the finger.
    func suppressSidebarSelectionBriefly() {
        sidebarSelectionSuppressedUntil = Date().addingTimeInterval(sidebarSelectionSuppressionDuration)
    }

    func shouldSuppressSidebarSelection() -> Bool {
        guard let suppressedUntil = sidebarSelectionSuppressedUntil else { return false }
        if Date() < suppressedUntil {
            return true
        }
        sidebarSelectionSuppressedUntil = nil
        return false
    }

    func setNewChatOpeningState(_ isOpening: Bool) {
        isOpeningNewChatFromSidebar = isOpening
        if isOpening {
            activeNewChatDraftRoute = nil
            selectedThread = nil
            codex.activeThreadId = nil
        }
    }

    // Keeps sidebar chat creation compose-first while preserving which affordance
    // opened it, so the draft UI can distinguish general Chat from folder Chat.
    func openNewChatDraftFromSidebar(
        source: NewChatDraftSource,
        preferredProjectPath: String?
    ) {
        let route = NewChatDraftRoute(
            id: "new-chat-draft-\(UUID().uuidString)",
            preferredProjectPath: preferredProjectPath,
            source: source
        )
        activeNewChatDraftRoute = route
        isOpeningNewChatFromSidebar = false
        selectedThread = nil
        codex.activeThreadId = nil

        if isSidebarOpen || sidebarDragOffset > 0 {
            closeSidebar()
        }
    }

    func openThreadFromNewChatDraft(_ thread: CodexThread) {
        isOpeningNewChatFromSidebar = false
        threadIDsPendingInitialAssistantAnchor.insert(thread.id)
        selectedThread = thread
        codex.activeThreadId = thread.id
        codex.markThreadAsViewed(thread.id)

        // We always render the thread inline (no nested NavigationStack split locally),
        // so drop the legacy `activeNewChatDraftRoute` here rather than waiting for a
        // navigationPath append. Matches upstream `else` branch in ba5c596.
        activeNewChatDraftRoute = nil
    }
    func finishGesture(open: Bool) {
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        debugSidebarLog("finishGesture open=\(open)")
        setSidebar(open: open)
    }

    // Forces UIKit-backed inputs like the composer/search text views to resign before the drawer moves.
    func setSidebar(open: Bool) {
        debugSidebarLog(
            "setSidebar open=\(open) prewarmed=\(isSidebarPrewarmed) "
                + "visible=\(sidebarVisible) revealWidth=\(Int(sidebarRevealWidth))"
        )
        if !open {
            isSearchActive = false
        }
        dismissActiveKeyboard()
        withAnimation(Self.sidebarSpring) {
            isSidebarOpen = open
            sidebarDragOffset = 0
        }
        sidebarGestureAutoCommitted = false
        resetSidebarGestureDebug()
    }

    // Warms the sidebar view tree offscreen after launch/reconnect so the first drawer gesture
    // doesn't pay the full mount/grouping cost in the animation frame budget.
    func scheduleSidebarPrewarmIfNeeded() {
        guard scenePhase == .active,
              hasSeenOnboarding,
              !isShowingManualScanner,
              !isSidebarPrewarmed,
              sidebarPrewarmTask == nil,
              (codex.isConnected || !codex.threads.isEmpty) else {
            debugSidebarLog(
                "prewarm skipped phase=\(String(describing: scenePhase)) onboarding=\(hasSeenOnboarding) "
                    + "scanner=\(isShowingManualScanner) "
                    + "prewarmed=\(isSidebarPrewarmed) taskActive=\(sidebarPrewarmTask != nil) "
                    + "connected=\(codex.isConnected) threadCount=\(codex.threads.count)"
            )
            return
        }

        debugSidebarLog("prewarm scheduled delayMs=\(sidebarPrewarmDelayNanoseconds / 1_000_000)")
        sidebarPrewarmTask = Task { @MainActor in
            defer { sidebarPrewarmTask = nil }
            try? await Task.sleep(nanoseconds: sidebarPrewarmDelayNanoseconds)
            guard !Task.isCancelled,
                  scenePhase == .active,
                  hasSeenOnboarding,
                  !isShowingManualScanner,
                  !isSidebarOpen,
                  sidebarDragOffset == 0,
                  (codex.isConnected || !codex.threads.isEmpty) else {
                debugSidebarLog("prewarm cancelled before completion")
                return
            }
            isSidebarPrewarmed = true
            debugSidebarLog("prewarm completed threadCount=\(codex.threads.count)")
        }
    }

    func teardownSidebarPrewarm() {
        debugSidebarLog("prewarm teardown requested sidebarOpen=\(isSidebarOpen) dragOffset=\(Int(sidebarDragOffset))")
        sidebarPrewarmTask?.cancel()
        sidebarPrewarmTask = nil
        if !isSidebarOpen, sidebarDragOffset == 0 {
            isSidebarPrewarmed = false
            debugSidebarLog("prewarm cleared")
        }
    }

    func beginSidebarGestureDebugIfNeeded(kind: String, startX: CGFloat) {
        guard Self.isSidebarDebugLoggingEnabled else { return }
        guard activeSidebarGestureDebugID == nil else { return }
        sidebarGestureDebugSequence += 1
        activeSidebarGestureDebugID = sidebarGestureDebugSequence
        lastSidebarGestureLogBucket = nil
        debugSidebarLog(
            "gesture #\(sidebarGestureDebugSequence) begin kind=\(kind) "
                + "startX=\(Int(startX)) sidebarOpen=\(isSidebarOpen) prewarmed=\(isSidebarPrewarmed)"
        )
    }

    func logSidebarGestureProgressIfNeeded(translation: CGFloat) {
        guard Self.isSidebarDebugLoggingEnabled else { return }
        guard let gestureID = activeSidebarGestureDebugID else { return }
        let bucket = max(0, Int(translation / sidebarGestureLogBucketWidth))
        guard bucket != lastSidebarGestureLogBucket else { return }
        lastSidebarGestureLogBucket = bucket
        debugSidebarLog(
            "gesture #\(gestureID) progress translation=\(Int(translation)) "
                + "bucket=\(bucket) revealWidth=\(Int(sidebarRevealWidth))"
        )
    }

    func resetSidebarGestureDebug() {
        activeSidebarGestureDebugID = nil
        lastSidebarGestureLogBucket = nil
    }

    // Gesture and lifecycle logs are lazy so release builds do not build strings on hot paths.
    func debugSidebarLog(_ message: @autoclosure () -> String) {
        #if DEBUG
        guard Self.isSidebarDebugLoggingEnabled else { return }
        print("[SidebarDebug] \(message())")
        #endif
    }

    // Uses the responder chain instead of per-view bindings so mixed SwiftUI/UIKit inputs all close together.
    func dismissActiveKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}
