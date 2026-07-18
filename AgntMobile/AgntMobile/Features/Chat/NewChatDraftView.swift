// FILE: NewChatDraftView.swift
// Purpose: Compose-first New Chat surface that lets users pick a local folder
//          before the first send creates the real runtime thread.
// Layer: View
// Exports: NewChatDraftRoute, NewChatDraftView
// Depends on: SwiftUI, PhotosUI, CodexService, TurnComposerHostView,
//             SidebarNewChatProjectPickerSheet, SidebarLocalFolderBrowserSheet

import PhotosUI
import SwiftUI

struct NewChatDraftRoute: Hashable {
    let id: String
    let preferredProjectPath: String?
    let source: NewChatDraftSource

    var isFromGeneralChat: Bool {
        source == .generalChat
    }
}

// Tracks which sidebar affordance opened the draft. UI experiments can branch
// on `route.isFromGeneralChat` while keeping thread creation logic shared.
enum NewChatDraftSource: Hashable {
    case generalChat
    case folderChat
}

// Picks which leading toolbar affordance the New Chat surface should show.
// Pushed routes fall back to the system back chevron (same as the rest of the
// chats); drawer mode swaps in the hamburger so the sidebar stays one tap away.
enum NewChatDraftLeadingControl {
    case back
    case hamburger(action: () -> Void)
}

struct NewChatDraftView: View {
    @Environment(CodexService.self) var codex
    @Environment(\.dynamicTypeSize) var dynamicTypeSize

    let route: NewChatDraftRoute
    var leadingControl: NewChatDraftLeadingControl = .back
    var onOpenTerminal: ((String?) -> Void)? = nil
    let onOpenThread: @MainActor @Sendable (CodexThread) -> Void

    @State var viewModel = TurnViewModel()
    @State var isInputFocused = false
    @State var selectedProjectPath: String?
    @State var projectlessChatRootPaths: [String] = []
    @State var activeSheet: NewChatDraftSheet?
    @State var hasInitializedProjectSelection = false
    @State var isLoadingRepositoryDiff = false
    @State var repositoryDiffPresentation: TurnDiffPresentation?
    @State var alertApprovalRequest: CodexApprovalRequest?
    @State var isApprovalAlertPresented = false
    @State var isShowingMacHandoffConfirm = false
    @State var macHandoffErrorMessage: String?
    @State var isDeferringSendForFocusDismissal = false

    // UI-only check for layout experiments: true when opened from the general
    // sidebar Chat affordance, false when opened from a folder section button.
    var isFromGeneralChat: Bool {
        route.isFromGeneralChat
    }

    var body: some View {
        // Keep the draft surface static while first send creates the real thread.
        VStack(spacing: 0) {
            if let pendingDraftUserMessage {
                pendingDraftUserMessageView(pendingDraftUserMessage)
            } else {
                Spacer(minLength: 0)
                promptStack
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
        .safeAreaInset(edge: .bottom, spacing: 0) {
            composer
        }
        .navigationTitle("New thread")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if case .hamburger(let action) = leadingControl {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: action) {
                        TwoLineHamburgerIcon()
                    }
                    .accessibilityLabel("Open menu")
                }
            }
            if #available(iOS 26.0, *) {
                ToolbarItem(placement: .title) {
                    toolbarTitleLabel
                }
            } else {
                ToolbarItem(placement: .principal) {
                    toolbarTitleLabel
                }
            }

            // Match the real thread toolbar so the Git/menu controls stay in one visual group
            // before and after the first message creates the runtime thread.
            if hasSelectedProject {
                ToolbarItem(placement: .topBarTrailing) {
                    draftGitActionsButton
                }

                if #available(iOS 26.0, *) {
                    ToolbarSpacer(.fixed, placement: .topBarTrailing)
                }

                ToolbarItem(placement: .topBarTrailing) {
                    draftThreadActionsMenu
                }
            } else {
                ToolbarItem(placement: .topBarTrailing) {
                    draftThreadActionsMenu
                }
            }
        }
        .task {
            initializeProjectSelectionIfNeeded()
            refreshDraftGitStateIfNeeded()
            await refreshProjectlessChatRoots()
            refreshDraftGitStateIfNeeded()
        }
        .onChange(of: projectChoices) { _, _ in
            initializeProjectSelectionIfNeeded()
        }
        .onChange(of: codex.isConnected) { _, isConnected in
            guard isConnected else { return }
            refreshDraftGitStateIfNeeded()
        }
        .onChange(of: selectedProjectPath) { _, _ in
            // Defer the observable-model mutation out of the .onChange action
            // to avoid AttributeGraph cycles when the parent re-renders.
            DispatchQueue.main.async { [viewModel] in
                viewModel.clearComposerAutocomplete()
            }
            refreshDraftGitStateForSelectedProject()
        }
        .sheet(item: $activeSheet) { sheet in
            sheetContent(sheet)
        }
        .sheet(item: $repositoryDiffPresentation) { presentation in
            TurnDiffSheet(
                title: presentation.title,
                entries: presentation.entries,
                bodyText: presentation.bodyText,
                messageID: presentation.messageID
            )
        }
        .turnViewAlerts(
            alertApprovalRequest: $alertApprovalRequest,
            isApprovalAlertPresented: $isApprovalAlertPresented,
            isShowingNothingToCommitAlert: isShowingNothingToCommitAlertBinding,
            gitSyncAlert: gitSyncAlertBinding,
            isShowingMacHandoffConfirm: $isShowingMacHandoffConfirm,
            macHandoffErrorMessage: $macHandoffErrorMessage,
            onDeclineApproval: { _ in },
            onApproveApproval: { _ in },
            onConfirmGitSyncAction: { action in
                viewModel.confirmGitSyncAlertAction(
                    action,
                    codex: codex,
                    workingDirectory: selectedProjectPath,
                    threadID: route.id,
                    activeTurnID: nil
                )
            },
            onDismissGitSyncAlert: {
                viewModel.dismissGitSyncAlert()
            },
            onConfirmMacHandoff: {}
        )
        .fullScreenCover(isPresented: isCameraPresentedBinding) {
            CameraImagePicker { data in
                viewModel.enqueueCapturedImageData(data, codex: codex, threadID: route.id)
            }
            .ignoresSafeArea()
        }
        .photosPicker(
            isPresented: isPhotoPickerPresentedBinding,
            selection: photoPickerItemsBinding,
            maxSelectionCount: max(1, viewModel.remainingAttachmentSlots),
            matching: .images,
            preferredItemEncoding: .automatic
        )
        .onChange(of: viewModel.photoPickerItems) { _, newItems in
            // Defer the observable-model mutation out of the .onChange action
            // to avoid AttributeGraph cycles when the parent re-renders.
            DispatchQueue.main.async { [viewModel] in
                viewModel.enqueuePhotoPickerItems(newItems, codex: codex, threadID: route.id)
                viewModel.photoPickerItems = []
            }
        }
        .animation(.easeInOut(duration: 0.18), value: pendingDraftUserMessage?.id)
    }

    // Shows the first user bubble while the app is still waiting for thread/start.
    var pendingDraftUserMessage: CodexMessage? {
        codex.messages(for: route.id).last { message in
            message.role == .user && message.deliveryState == .pending
        }
    }

    func initializeProjectSelectionIfNeeded() {
        guard !hasInitializedProjectSelection else { return }

        selectedProjectPath = CodexThreadStartProjectBinding.normalizedProjectPath(route.preferredProjectPath)
            ?? projectChoices.first?.projectPath
        hasInitializedProjectSelection = selectedProjectPath != nil || !projectChoices.isEmpty
    }

    func refreshProjectlessChatRoots() async {
        guard codex.isConnected else { return }

        do {
            let roots = try await codex.fetchProjectlessChatRoots().roots
            guard roots != projectlessChatRootPaths else { return }
            projectlessChatRootPaths = roots
            initializeProjectSelectionIfNeeded()
        } catch {
            // Project grouping still has built-in fallbacks for older local bridges.
        }
    }

    func sendDraft() {
        guard !isDeferringSendForFocusDismissal else { return }
        isDeferringSendForFocusDismissal = true
        isInputFocused = false

        let openThread: @MainActor @Sendable (CodexThread) -> Void = { thread in
            onOpenThread(thread)
        }
        Task { @MainActor in
            await Task.yield()
            viewModel.sendNewThread(
                codex: codex,
                draftThreadID: route.id,
                preferredProjectPath: selectedProjectPath,
                onThreadCreated: openThread
            )
            isDeferringSendForFocusDismissal = false
        }
    }

    @ViewBuilder
    func sheetContent(_ sheet: NewChatDraftSheet) -> some View {
        switch sheet {
        case .projectPicker:
            SidebarNewChatProjectPickerSheet(
                choices: projectChoices,
                showsWithoutProjectOption: false,
                showsWorktreeOptions: false,
                onSelectProject: { projectPath in
                    selectedProjectPath = projectPath
                    activeSheet = nil
                },
                onSelectWorktreeProject: { projectPath in
                    selectedProjectPath = projectPath
                    activeSheet = nil
                },
                onSelectWithoutProject: {
                    selectedProjectPath = nil
                    activeSheet = nil
                },
                onBrowseLocalFolder: {
                    activeSheet = .localFolderBrowser
                }
            )
        case .localFolderBrowser:
            SidebarLocalFolderBrowserSheet { projectPath in
                selectedProjectPath = projectPath
                activeSheet = nil
            }
        }
    }
}

enum NewChatDraftSheet: String, Identifiable {
    case projectPicker
    case localFolderBrowser

    var id: String { rawValue }
}
