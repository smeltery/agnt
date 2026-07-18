// FILE: NewChatDraftViewSupport.swift
// Purpose: Provides New Chat draft presentation, Git toolbar, and composer helpers.
// Layer: View Support
// Exports: NewChatDraftView support helpers

import PhotosUI
import SwiftUI

extension NewChatDraftView {
    func pendingDraftUserMessageView(_ message: CodexMessage) -> some View {
        VStack(spacing: 0) {
            MessageRow(
                message: message,
                isRetryAvailable: false,
                onRetryUserMessage: { _ in }
            )
            .padding(.horizontal, draftTimelineHorizontalPadding)
            .padding(.top, 12)

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .transition(.opacity)
    }

    var draftTimelineHorizontalPadding: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 20 : 16
    }

    // Source-specific prompt UI:
    // - Project-backed General Chat exposes the available-folder context menu
    //   before first send; global/rootless Chat stays picker-free.
    // - Folder/project button keeps the normal title because that folder is already implied.
    // Regression guard: the Projects general-chat empty state must stay as
    // "What should we work on?" followed by the folder-only picker, while the
    // global Chats pill stays just "What should we work on?" + input.
    var promptStack: some View {
        Group {
            if isFromGeneralChat {
                generalChatPrompt
            } else {
                folderButtonPrompt
            }
        }
        .padding()
    }

    var generalChatPrompt: some View {
        VStack(spacing: 8) {
            ChatLogoBadge()
                .padding(.bottom, 4)
            Text("What should we work on?")
                .font(AppFont.title2(weight: .regular))
                .foregroundStyle(.primary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 28)

            if showsGeneralFolderPicker {
                // Visible only for project-backed general chat; rootless global Chat stays bare.
                folderPickerPill
            }
            Text("Chats are End-to-end encrypted")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 28)
        }
    }

    var folderButtonPrompt: some View {
        VStack(spacing: 12) {
            ChatLogoBadge()
            ChatEmptyStateTitleBuilder.makeTitle(for: placeholderFolderName)
                .font(AppFont.title2(weight: .regular))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 28)
            Text("Chats are End-to-end encrypted")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 28)
        }
    }

    var toolbarTitleLabel: some View {
        TurnChatToolbarTitleLabel(
            title: "New thread",
            subtitle: placeholderFolderName ?? trustedHostName,
            // General chat uses the inline context menu; folder-backed drafts can still open the sheet.
            onTap: !isFromGeneralChat && hasSelectedProject ? { activeSheet = .projectPicker } : nil,
            accessibilityHint: !isFromGeneralChat && hasSelectedProject ? "Opens the project picker" : nil
        )
    }

    // Only Quick Chat / no-folder drafts are blocked. If the draft already has
    // a selected project (including the default latest-used project from the
    // general Chat button), expose the same Git state/actions as TurnView.
    var draftGitActionsButton: some View {
        TurnGitActionsToolbarButton(
            isEnabled: isDraftGitActionEnabled,
            disabledActions: areDraftToolbarActionsDisabled ? Set(TurnGitActionKind.allCases) : viewModel.disabledGitActions,
            isRunningAction: viewModel.isRunningGitAction,
            loadingTitle: nil,
            showsDiscardRuntimeChangesAndSync: viewModel.shouldShowDiscardRuntimeChangesAndSync,
            gitSyncState: viewModel.gitSyncState,
            onSelect: handleDraftGitActionSelection
        )
        .opacity(areDraftToolbarActionsDisabled ? 0.45 : 1)
        .disabled(areDraftToolbarActionsDisabled)
    }

    // Mirrors the regular chat ellipsis chrome. It is disabled only for the
    // general Chat draft, where the folder can still change before first send.
    var draftThreadActionsMenu: some View {
        TurnThreadActionsMenuButton(
            isLoading: false,
            isEnabled: !areDraftToolbarActionsDisabled,
            actions: draftThreadActions
        )
    }

    var draftThreadActions: [TurnThreadActionMenuItem] {
        [
            TurnThreadActionMenuItem(
                title: "Open Terminal Here",
                icon: .system("terminal"),
                isEnabled: !areDraftToolbarActionsDisabled && onOpenTerminal != nil
            ) {
                onOpenTerminal?(selectedProjectPath)
            },
        ]
    }

    var areDraftToolbarActionsDisabled: Bool {
        !hasSelectedProject
    }

    var isDraftGitActionEnabled: Bool {
        !areDraftToolbarActionsDisabled
            && viewModel.gitRepoSync != nil
            && viewModel.canRunGitAction(
                isConnected: codex.isConnected,
                isThreadRunning: false,
                hasGitWorkingDirectory: selectedProjectPath != nil
            )
    }

    // Drafts refresh only the selected project's Git state so the secondary
    // composer bar can show Local/branch controls before the first send.
    func refreshDraftGitStateIfNeeded() {
        guard hasSelectedProject, codex.isConnected else {
            return
        }
        viewModel.refreshGitBranchTargets(
            codex: codex,
            workingDirectory: selectedProjectPath,
            threadID: route.id
        )
    }

    func refreshDraftGitStateForSelectedProject() {
        resetDraftGitState()
        refreshDraftGitStateIfNeeded()
    }

    func resetDraftGitState() {
        viewModel.gitRepoSync = nil
        viewModel.currentGitBranch = ""
        viewModel.availableGitBranchTargets = []
        viewModel.gitBranchesCheckedOutElsewhere = []
        viewModel.gitWorktreePathsByBranch = [:]
        viewModel.gitLocalCheckoutPath = nil
        viewModel.gitDefaultBranch = ""
        viewModel.selectedGitBaseBranch = ""
    }

    var hasSelectedProject: Bool {
        selectedProjectPath?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

    var showsGeneralFolderPicker: Bool {
        isFromGeneralChat
            && CodexThreadStartProjectBinding.normalizedProjectPath(route.preferredProjectPath) != nil
    }

    func handleDraftGitActionSelection(_ action: TurnGitActionKind) {
        guard isDraftGitActionEnabled else { return }
        viewModel.triggerGitAction(
            action,
            codex: codex,
            workingDirectory: selectedProjectPath,
            threadID: route.id,
            activeTurnID: nil
        )
    }

    // Fetches the repo patch for folder-backed drafts so the Git menu's
    // "Changes" row matches the regular TurnView toolbar behavior.
    func presentRepositoryDiff() {
        guard !isLoadingRepositoryDiff,
              !areDraftToolbarActionsDisabled else {
            return
        }
        isLoadingRepositoryDiff = true

        Task { @MainActor in
            defer { isLoadingRepositoryDiff = false }

            let gitService = GitActionsService(codex: codex, workingDirectory: selectedProjectPath)
            do {
                let result = try await gitService.diff()
                guard let presentation = TurnDiffPresentationBuilder.repositoryPresentation(from: result.patch) else {
                    viewModel.gitSyncAlert = TurnGitSyncAlert(
                        title: "Git Error",
                        message: "There are no repository changes to show.",
                        action: .dismissOnly
                    )
                    return
                }
                repositoryDiffPresentation = presentation
            } catch let error as GitActionsError {
                viewModel.gitSyncAlert = TurnGitSyncAlert(
                    title: "Git Error",
                    message: error.errorDescription ?? "Could not load repository changes.",
                    action: .dismissOnly
                )
            } catch {
                viewModel.gitSyncAlert = TurnGitSyncAlert(
                    title: "Git Error",
                    message: error.localizedDescription,
                    action: .dismissOnly
                )
            }
        }
    }

    var isShowingNothingToCommitAlertBinding: Binding<Bool> {
        Binding(
            get: { viewModel.isShowingNothingToCommitAlert },
            set: { viewModel.isShowingNothingToCommitAlert = $0 }
        )
    }

    var gitSyncAlertBinding: Binding<TurnGitSyncAlert?> {
        Binding(
            get: { viewModel.gitSyncAlert },
            set: { newValue in
                if let newValue {
                    viewModel.gitSyncAlert = newValue
                } else {
                    viewModel.dismissGitSyncAlert()
                }
            }
        )
    }

    var placeholderFolderName: String? {
        guard let selectedProjectPath,
              !selectedProjectPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return selectedProjectPath.pathDisplayName
    }

    // Always reads the same way as the toolbar subtitle so the pill and the
    // navigation block never disagree on what folder is currently bound.
    var folderPillLabel: String {
        placeholderFolderName ?? "Quick Chat"
    }

    // Compact inline picker shown below the "What should we work on?" prompt.
    // Regression guard: this is a context menu of available folders only, not
    // the full new-chat sheet and not a Quick Chat selector.
    var folderPickerPill: some View {
        Menu {
            folderPickerMenuContent
        } label: {
            HStack(spacing: 6) {
                pickerIcon
                    .frame(width: 18, height: 18)
                Text(folderPillLabel)
                    .font(AppFont.title2(weight: .regular))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.up.chevron.down")
                    .font(AppFont.body(weight: .regular))
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .contentShape(Capsule())
        }
        .menuOrder(.fixed)
        .accessibilityLabel("Select folder")
        .accessibilityHint("Opens available folders")
        .accessibilityValue(folderPillLabel)
    }

    // Builds the small folder-only menu used by the general-chat empty state.
    @ViewBuilder
    var folderPickerMenuContent: some View {
        if projectChoices.isEmpty {
            Button {
                // Disabled placeholder so the menu still opens with feedback.
            } label: {
                Label("No folders available", systemImage: "folder")
            }
            .disabled(true)
        } else {
            ForEach(projectChoices) { choice in
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    selectedProjectPath = choice.projectPath
                } label: {
                    if selectedProjectPath == choice.projectPath {
                        Label(choice.label, systemImage: "checkmark")
                    } else {
                        Label(choice.label, systemImage: choice.iconSystemName)
                    }
                }
            }
        }
    }

    // SF Symbol fallbacks: chat bubbles for Quick Chat, folder glyph for
    // project-backed drafts.
    var pickerIcon: some View {
        Image(systemName: placeholderFolderName == nil
              ? "bubble.left.and.bubble.right"
              : "folder")
            .resizable()
            .scaledToFit()
    }

    var trustedHostName: String? {
        let trimmed = (codex.trustedPairPresentation?.name ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    var composer: some View {
        TurnComposerHostView(
            viewModel: viewModel,
            codex: codex,
            thread: draftThread,
            activeTurnID: nil,
            isThreadRunning: false,
            isEmptyThread: true,
            isWorktreeProject: false,
            canForkLocally: false,
            isInputFocused: $isInputFocused,
            orderedModelOptions: orderedModelOptions,
            selectedModelTitle: selectedModelTitle,
            reasoningDisplayOptions: reasoningDisplayOptions,
            showsGitControls: hasSelectedProject && viewModel.isGitRepositoryInitialized,
            isGitBranchSelectorEnabled: isDraftGitActionEnabled && viewModel.isGitRepositoryInitialized,
            onSelectGitBranch: { branch in
                guard hasSelectedProject else { return }
                viewModel.requestSwitchGitBranch(
                    to: branch,
                    codex: codex,
                    workingDirectory: selectedProjectPath,
                    threadID: route.id,
                    activeTurnID: nil
                )
            },
            onCreateGitBranch: { branchName in
                guard hasSelectedProject else { return }
                viewModel.requestCreateGitBranch(
                    named: branchName,
                    codex: codex,
                    workingDirectory: selectedProjectPath,
                    threadID: route.id,
                    activeTurnID: nil
                )
            },
            onRefreshGitBranches: {
                guard hasSelectedProject, viewModel.isGitRepositoryInitialized else { return }
                viewModel.refreshGitBranchTargets(
                    codex: codex,
                    workingDirectory: selectedProjectPath,
                    threadID: route.id
                )
            },
            onStartCodeReviewThread: { target in
                viewModel.applyPendingComposerAction(.codeReview(target: target.codexPendingTarget))
            },
            onStartForkThreadLocally: {},
            onOpenForkWorktree: {},
            onOpenWorktreeHandoff: {},
            onOpenFeedbackMail: {},
            onShowStatus: {},
            onShowGoal: { _ in },
            onCompactThread: {},
            voiceButtonPresentation: voiceButtonPresentation,
            isVoiceRecording: false,
            voiceAudioLevels: [],
            voiceRecordingDuration: 0,
            onTapVoice: {},
            onCancelVoiceRecording: {},
            onSend: sendDraft,
            showsSecondaryBar: true
        )
    }

    // Inline default presentation matching TurnView's idle mic state — the draft
    // surface never enters the recording / transcribing / preflighting branches
    // because no thread exists yet, so we only emit the connected/disconnected
    // "ready" form.
    var voiceButtonPresentation: TurnComposerVoiceButtonPresentation {
        TurnComposerVoiceButtonPresentation(
            systemImageName: "mic",
            foregroundColor: Color(.secondaryLabel),
            backgroundColor: .clear,
            accessibilityLabel: "Start voice transcription",
            isDisabled: !codex.isConnected,
            showsProgress: false,
            hasCircleBackground: false
        )
    }

    var draftThread: CodexThread {
        CodexThread(
            id: route.id,
            title: "New thread",
            cwd: selectedProjectPath
        )
    }

    var projectChoices: [SidebarProjectChoice] {
        SidebarThreadGrouping.makeProjectChoices(
            from: codex.threads,
            projectlessRootPaths: projectlessChatRootPaths
        )
    }

    var orderedModelOptions: [CodexModelOption] {
        TurnComposerMetaMapper.orderedModels(from: codex.availableModels)
    }

    var reasoningDisplayOptions: [TurnComposerReasoningDisplayOption] {
        TurnComposerMetaMapper.reasoningDisplayOptions(
            from: codex.supportedReasoningEffortsForSelectedModel().map(\.reasoningEffort)
        )
    }

    var selectedModelTitle: String {
        if let selectedModel = codex.selectedModelOption() {
            return TurnComposerMetaMapper.modelTitle(for: selectedModel)
        }

        return TurnComposerMetaMapper.modelTitle(forIdentifier: codex.selectedModelId)
    }

    var isPhotoPickerPresentedBinding: Binding<Bool> {
        Binding(
            get: { viewModel.isPhotoPickerPresented },
            set: { viewModel.isPhotoPickerPresented = $0 }
        )
    }

    var isCameraPresentedBinding: Binding<Bool> {
        Binding(
            get: { viewModel.isCameraPresented },
            set: { viewModel.isCameraPresented = $0 }
        )
    }

    var photoPickerItemsBinding: Binding<[PhotosPickerItem]> {
        Binding(
            get: { viewModel.photoPickerItems },
            set: { viewModel.photoPickerItems = $0 }
        )
    }

}
