// FILE: TurnView.swift
// Purpose: Orchestrates turn screen composition, wiring service state to timeline + composer components.
// Layer: View
// Exports: TurnView
// Depends on: CodexService, TurnViewModel, TurnConversationContainerView, TurnComposerHostView, TurnViewAlertModifier, TurnViewLifecycleModifier

import SwiftUI
import PhotosUI
import UIKit

struct TurnView: View {
    let thread: CodexThread
    let isWakingMacDisplayRecovery: Bool
    let initialShouldAnchorToAssistantResponse: Bool
    let onInitialAssistantAnchorConsumed: (() -> Void)?
    var onOpenTerminal: ((String?) -> Void)? = nil

    @Environment(CodexService.self) var codex
    @Environment(\.openURL) var openURL
    @Environment(\.reconnectAction) var reconnectAction
    @Environment(\.wakeMacDisplayAction) var wakeMacDisplayAction
    @Environment(\.scenePhase) var scenePhase
    @State var viewModel: TurnViewModel
    @State var isInputFocused = false
    @State var isShowingThreadPathSheet = false
    @State var isShowingStatusSheet = false
    @State var isShowingGoalSheet = false
    @State var goalSheetObjectivePrefill: String?
    @State var goalSheetComposerConsumedInput: String?
    @State var isLoadingRepositoryDiff = false
    @State var repositoryDiffPresentation: TurnDiffPresentation?
    @State var assistantRevertSheetState: AssistantRevertSheetState?
    @State var alertApprovalRequest: CodexApprovalRequest?
    @State var isApprovalAlertPresented = false
    @State var isShowingMacHandoffConfirm = false
    @State var isShowingWorktreeHandoff = false
    @State var isShowingForkWorktree = false
    @State var macHandoffErrorMessage: String?
    @State var isHandingOffToMac = false
    @State var isStartingSiblingChat = false
    @State var isForkingThread = false
    @State var checkedOutElsewhereAlert: CheckedOutElsewhereAlert?
    @State var isVoiceRecording = false
    @State var isVoicePreflighting = false
    @State var voicePreflightGeneration = 0
    @State var isVoiceTranscribing = false
    @State var hasTriggeredVoiceAutoStop = false
    @State var voiceRecoveryReason: CodexVoiceFailureReason?
    @State var isShowingVoiceSetupSheet = false
    @State var hasConsumedInitialAssistantAnchor = false
    @StateObject var voiceTranscriptionManager = GPTVoiceTranscriptionManager()
    @State var workspaceFilePreviewRequest: WorkspaceFilePreviewRequest?

    init(
        thread: CodexThread,
        isWakingMacDisplayRecovery: Bool,
        initialShouldAnchorToAssistantResponse: Bool = false,
        onInitialAssistantAnchorConsumed: (() -> Void)? = nil,
        onOpenTerminal: ((String?) -> Void)? = nil
    ) {
        self.thread = thread
        self.isWakingMacDisplayRecovery = isWakingMacDisplayRecovery
        self.initialShouldAnchorToAssistantResponse = initialShouldAnchorToAssistantResponse
        self.onInitialAssistantAnchorConsumed = onInitialAssistantAnchorConsumed
        self.onOpenTerminal = onOpenTerminal
        _viewModel = State(initialValue: TurnViewModel(
            shouldAnchorToAssistantResponse: initialShouldAnchorToAssistantResponse
        ))
    }

    // ─── ENTRY POINT ─────────────────────────────────────────────
    var body: some View {
        turnBody
    }
}

#Preview {
    NavigationStack {
        TurnView(
            thread: CodexThread(id: "thread_preview", title: "Preview"),
            isWakingMacDisplayRecovery: false
        )
            .environment(CodexService())
    }
}
