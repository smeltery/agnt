// FILE: TurnComposerView.swift
// Purpose: Renders the turn composer input, queued-draft actions, attachments, and send/stop controls.
// Layer: View Component (orchestrator)
// Exports: TurnComposerView
// Depends on: SwiftUI, ComposerAttachmentsPreview, FileAutocompletePanel, SkillAutocompletePanel, SlashCommandAutocompletePanel, ComposerBottomBar, QueuedDraftsPanel, FileMentionChip, TurnComposerInputTextView, TurnComposerSecondaryBar

import SwiftUI
import UIKit

struct TurnComposerView: View {
    @Binding var input: String
    let isInputFocused: Binding<Bool>

    let accessoryState: TurnComposerAccessoryState
    let autocompleteState: TurnComposerAutocompleteState
    let remainingAttachmentSlots: Int
    let isComposerInteractionLocked: Bool
    let isSendDisabled: Bool
    let isSending: Bool
    let isPlanModeArmed: Bool
    let queuedCount: Int
    let isQueuePaused: Bool
    let activeTurnID: String?
    let isThreadRunning: Bool
    let isEmptyThread: Bool
    let hasWorkingDirectory: Bool
    let isWorktreeProject: Bool
    var activeFileChangeStatus: FileChangeStatusSnapshot? = nil
    var threadGoal: CodexThreadGoal? = nil

    let orderedModelOptions: [CodexModelOption]
    let selectedModelID: String?
    let selectedModelTitle: String
    let isLoadingModels: Bool
    let isRuntimeSelectionLoading: Bool

    let runtimeState: TurnComposerRuntimeState
    let runtimeActions: TurnComposerRuntimeActions
    let voiceButtonPresentation: TurnComposerVoiceButtonPresentation

    let selectedAccessMode: CodexAccessMode
    let contextWindowUsage: ContextWindowUsage?
    let rateLimitBuckets: [CodexRateLimitBucket]
    let isLoadingRateLimits: Bool
    let rateLimitsErrorMessage: String?
    let shouldAutoRefreshUsageStatus: Bool

    let showsGitBranchSelector: Bool
    let isGitBranchSelectorEnabled: Bool
    let availableGitBranchTargets: [String]
    let gitBranchesCheckedOutElsewhere: Set<String>
    let gitWorktreePathsByBranch: [String: String]
    let selectedGitBaseBranch: String
    let currentGitBranch: String
    let gitDefaultBranch: String
    let isLoadingGitBranchTargets: Bool
    let isSwitchingGitBranch: Bool
    let isCreatingGitWorktree: Bool
    let onSelectGitBranch: (String) -> Void
    let onCreateGitBranch: (String) -> Void
    let onSelectGitBaseBranch: (String) -> Void
    let onRefreshGitBranches: () -> Void
    let onRefreshUsageStatus: () async -> Void
    let onEditGoal: () -> Void
    let onResumeGoal: () -> Void
    let onPauseGoal: () -> Void
    let onRemoveGoal: () -> Void

    let onSelectAccessMode: (CodexAccessMode) -> Void
    let canHandOffToWorktree: Bool
    let onTapAddImage: () -> Void
    let onTapTakePhoto: () -> Void
    let onTapVoice: () -> Void
    let onCancelVoiceRecording: () -> Void
    let onTapCreateWorktree: () -> Void
    let onSetPlanModeArmed: (Bool) -> Void
    let onRemoveAttachment: (String) -> Void
    let onStopTurn: (String?) -> Void
    let onInputChangedForFileAutocomplete: (String) -> Void
    let onInputChangedForSkillAutocomplete: (String) -> Void
    let onInputChangedForPluginAutocomplete: (String) -> Void
    let onInputChangedForSlashCommandAutocomplete: (String) -> Void
    let onSelectFileAutocomplete: (CodexFuzzyFileMatch) -> Void
    let onSelectSkillAutocomplete: (CodexSkillMetadata) -> Void
    let onSelectPluginAutocomplete: (CodexPluginMetadata) -> Void
    let onSelectSlashCommand: (TurnComposerSlashCommand) -> Void
    let onSelectCodeReviewTarget: (TurnComposerReviewTarget) -> Void
    let onSelectForkDestination: (TurnComposerForkDestination) -> Void
    let onCloseSlashCommandPanel: () -> Void
    let onRemoveMentionedFile: (String) -> Void
    let onRemoveMentionedSkill: (String) -> Void
    let onRemoveMentionedPlugin: (String) -> Void
    let onRemoveComposerReviewSelection: () -> Void
    let onRemoveComposerSubagentsSelection: () -> Void
    let onPasteImageData: ([Data]) -> Void
    let onResumeQueue: () -> Void
    let onRestoreQueuedDraft: (String) -> Void
    let onSteerQueuedDraft: (String) -> Void
    let onRemoveQueuedDraft: (String) -> Void
    let onSend: () -> Void
    // Call sites can hide the lower runtime/git/access row for constrained
    // surfaces, but project-backed new-chat drafts keep it visible.
    var showsSecondaryBar: Bool = true
    var allowsCollapsedComposer: Bool = true

    private let expandedPlainTextMaxVisibleLines: CGFloat = 6
    private let expandedAccessoryTextMaxVisibleLines: CGFloat = 4
    @ScaledMetric(relativeTo: .body) private var collapsedInputHeight: CGFloat = 22
    private let collapsedControlTapTarget: CGFloat = 32

    @State private var composerInputHeight: CGFloat = 32
    @State private var inputChangeTask: Task<Void, Never>?
    @State private var isShowingQueuedDraftsSheet = false

    private var showsSendButton: Bool {
        !isThreadRunning || accessoryState.hasSendableContent(input: input)
    }

    private var showsCollapsedComposer: Bool {
        allowsCollapsedComposer
            && !isInputFocused.wrappedValue
            && input.isEmpty
            && !accessoryState.hasTopAccessoryContent
            && !accessoryState.showsVoiceRecordingCapsule
    }

    // ─── ENTRY POINT ─────────────────────────────────────────────
    var body: some View {
        VStack(spacing: 6) {
            if accessoryState.showsVoiceRecordingCapsule {
                VoiceRecordingCapsule(
                    audioLevels: accessoryState.voiceAudioLevels,
                    duration: accessoryState.voiceRecordingDuration,
                    onCancel: onCancelVoiceRecording
                )
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            if showsSecondaryBar && !accessoryState.showsVoiceRecordingCapsule {
                TurnComposerSecondaryBar(
                    isInputFocused: isInputFocused.wrappedValue,
                    isEmptyThread: isEmptyThread,
                    hasWorkingDirectory: hasWorkingDirectory,
                    isWorktreeProject: isWorktreeProject,
                    activeFileChangeStatus: activeFileChangeStatus,
                    threadGoal: threadGoal,
                    isThreadRunning: isThreadRunning,
                    onEditGoal: onEditGoal,
                    onResumeGoal: onResumeGoal,
                    onPauseGoal: onPauseGoal,
                    onRemoveGoal: onRemoveGoal,
                    queuedDraftCount: accessoryState.queuedDrafts.count,
                    onTapQueuedDrafts: { isShowingQueuedDraftsSheet = true },
                    showsGitBranchSelector: showsGitBranchSelector,
                    isGitBranchSelectorEnabled: isGitBranchSelectorEnabled,
                    availableGitBranchTargets: availableGitBranchTargets,
                    gitBranchesCheckedOutElsewhere: gitBranchesCheckedOutElsewhere,
                    gitWorktreePathsByBranch: gitWorktreePathsByBranch,
                    selectedGitBaseBranch: selectedGitBaseBranch,
                    currentGitBranch: currentGitBranch,
                    gitDefaultBranch: gitDefaultBranch,
                    isLoadingGitBranchTargets: isLoadingGitBranchTargets,
                    isSwitchingGitBranch: isSwitchingGitBranch,
                    isCreatingGitWorktree: isCreatingGitWorktree,
                    onSelectGitBranch: onSelectGitBranch,
                    onCreateGitBranch: onCreateGitBranch,
                    onSelectGitBaseBranch: onSelectGitBaseBranch,
                    onRefreshGitBranches: onRefreshGitBranches,
                    canHandOffToWorktree: canHandOffToWorktree,
                    onTapCreateWorktree: onTapCreateWorktree
                )
            }

            VStack(spacing: 0) {
                if !showsCollapsedComposer {
                    TurnComposerAccessorySection(
                        state: accessoryState,
                        onRemoveAttachment: onRemoveAttachment,
                        onRemoveMentionedFile: onRemoveMentionedFile,
                        onRemoveMentionedSkill: onRemoveMentionedSkill,
                        onRemoveMentionedPlugin: onRemoveMentionedPlugin,
                        onRemoveComposerReviewSelection: onRemoveComposerReviewSelection,
                        onRemoveComposerSubagentsSelection: onRemoveComposerSubagentsSelection
                    )
                }

                HStack(alignment: .center, spacing: 8) {
                    if showsCollapsedComposer {
                        ComposerAttachmentMenu(
                            isPlanModeArmed: isPlanModeArmed,
                            runtimeState: runtimeState,
                            runtimeActions: runtimeActions,
                            remainingAttachmentSlots: remainingAttachmentSlots,
                            isInteractionLocked: isComposerInteractionLocked,
                            onSetPlanModeArmed: onSetPlanModeArmed,
                            onTapAddImage: onTapAddImage,
                            onTapTakePhoto: onTapTakePhoto,
                            tapTargetSide: collapsedControlTapTarget
                        )
                        .frame(width: collapsedControlTapTarget, height: collapsedControlTapTarget)
                        .transition(.opacity)
                    }

                    ZStack(alignment: showsCollapsedComposer ? .leading : .topLeading) {
                        if input.isEmpty {
                            Text(placeholderText)
                                .font(AppFont.body())
                                .foregroundStyle(Color(.placeholderText))
                                .lineLimit(1)
                                .frame(
                                    maxWidth: .infinity,
                                    minHeight: showsCollapsedComposer ? collapsedInputHeight : 0,
                                    alignment: showsCollapsedComposer ? .leading : .topLeading
                                )
                                .allowsHitTesting(false)
                        }

                        TurnComposerInputTextView(
                            text: $input,
                            isFocused: isInputFocused,
                            isEditable: !isComposerInteractionLocked,
                            dynamicHeight: $composerInputHeight,
                            runtimeState: runtimeState,
                            runtimeActions: runtimeActions,
                            maxVisibleLines: expandedInputMaxVisibleLines,
                            onPasteImageData: { imageDataItems in
                                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                                onPasteImageData(imageDataItems)
                            }
                        )
                        .frame(height: showsCollapsedComposer ? collapsedInputHeight : max(composerInputHeight, 34))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        guard !isComposerInteractionLocked else { return }
                        isInputFocused.wrappedValue = true
                    }

                    if showsCollapsedComposer {
                        ComposerVoiceButton(
                            presentation: voiceButtonPresentation,
                            onTap: onTapVoice,
                            tapTargetSide: collapsedControlTapTarget
                        )
                        .frame(width: collapsedControlTapTarget, height: collapsedControlTapTarget)
                        .transition(.opacity)

                        if isThreadRunning {
                            ComposerStopControl(
                                activeTurnID: activeTurnID,
                                isSending: isSending,
                                onStopTurn: onStopTurn
                            )
                            .transition(.opacity)
                        }
                    }
                }
                .padding(.leading, showsCollapsedComposer ? 6 : 16)
                .padding(.trailing, showsCollapsedComposer ? 6 : 16)
                .padding(.top, showsCollapsedComposer ? 6 : accessoryState.topInputPadding + 4)
                .padding(.bottom, showsCollapsedComposer ? 6 : 4)
                .onChange(of: input) { _, newValue in
                    inputChangeTask?.cancel()
                    // Coalesce fast typing into one autocomplete refresh per main-actor turn.
                    inputChangeTask = Task { @MainActor in
                        await Task.yield()
                        guard !Task.isCancelled else { return }
                        onInputChangedForFileAutocomplete(newValue)
                        onInputChangedForSkillAutocomplete(newValue)
                        onInputChangedForPluginAutocomplete(newValue)
                        onInputChangedForSlashCommandAutocomplete(newValue)
                    }
                }

                if !showsCollapsedComposer {
                    expandedBottomBar
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: composerSurfaceCornerRadius))
            .clipShape(RoundedRectangle(cornerRadius: composerSurfaceCornerRadius))
            .padding(.horizontal, showsCollapsedComposer ? 8 : 0)
            .overlay(alignment: .topLeading) {
                Color.clear
                    .frame(maxWidth: .infinity, maxHeight: 0, alignment: .topLeading)
                    .overlay(alignment: .bottomLeading) {
                        TurnComposerAutocompletePanels(
                            state: autocompleteState,
                            onSelectFileAutocomplete: onSelectFileAutocomplete,
                            onSelectSkillAutocomplete: onSelectSkillAutocomplete,
                            onSelectPluginAutocomplete: onSelectPluginAutocomplete,
                            onSelectSlashCommand: onSelectSlashCommand,
                            onSelectCodeReviewTarget: onSelectCodeReviewTarget,
                            onSelectForkDestination: onSelectForkDestination,
                            onCloseSlashCommandPanel: onCloseSlashCommandPanel
                        )
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .offset(y: -8)
            }
            .zIndex(2)
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.snappy(duration: 0.26), value: showsCollapsedComposer)
        .sheet(isPresented: $isShowingQueuedDraftsSheet) {
            QueuedDraftsSheet(
                drafts: accessoryState.queuedDrafts,
                canSteerDrafts: accessoryState.canSteerQueuedDrafts,
                canRestoreDrafts: accessoryState.canRestoreQueuedDrafts,
                steeringDraftID: accessoryState.steeringDraftID,
                onRestore: onRestoreQueuedDraft,
                onSteer: onSteerQueuedDraft,
                onRemove: onRemoveQueuedDraft
            )
        }
        .onChange(of: accessoryState.hasQueuedDrafts) { _, hasDrafts in
            if !hasDrafts {
                isShowingQueuedDraftsSheet = false
            }
        }
    }

    private var expandedBottomBar: some View {
        ComposerBottomBar(
            orderedModelOptions: orderedModelOptions,
            selectedModelID: selectedModelID,
            selectedModelTitle: selectedModelTitle,
            isLoadingModels: isLoadingModels,
            isRuntimeSelectionLoading: isRuntimeSelectionLoading,
            runtimeState: runtimeState,
            runtimeActions: runtimeActions,
            remainingAttachmentSlots: remainingAttachmentSlots,
            isComposerInteractionLocked: isComposerInteractionLocked,
            isSendDisabled: isSendDisabled,
            isSending: isSending,
            isPlanModeArmed: isPlanModeArmed,
            queuedCount: queuedCount,
            isQueuePaused: isQueuePaused,
            activeTurnID: activeTurnID,
            isThreadRunning: isThreadRunning,
            showsSendButton: showsSendButton,
            voiceButtonPresentation: voiceButtonPresentation,
            selectedAccessMode: selectedAccessMode,
            contextWindowUsage: contextWindowUsage,
            rateLimitBuckets: rateLimitBuckets,
            isLoadingRateLimits: isLoadingRateLimits,
            rateLimitsErrorMessage: rateLimitsErrorMessage,
            shouldAutoRefreshUsageStatus: shouldAutoRefreshUsageStatus,
            onRefreshUsageStatus: onRefreshUsageStatus,
            onSelectAccessMode: onSelectAccessMode,
            onTapAddImage: onTapAddImage,
            onTapTakePhoto: onTapTakePhoto,
            onTapVoice: onTapVoice,
            onSetPlanModeArmed: onSetPlanModeArmed,
            onResumeQueue: onResumeQueue,
            onStopTurn: onStopTurn,
            onSend: onSend
        )
    }

    private var placeholderText: String {
        isEmptyThread ? "Ask anything... @plugins, $skills, /commands" : "Follow up"
    }

    private var collapsedRowContentHeight: CGFloat {
        max(collapsedInputHeight, collapsedControlTapTarget)
    }

    private var composerSurfaceCornerRadius: CGFloat {
        showsCollapsedComposer ? (collapsedRowContentHeight + 12) / 2 : 26
    }

    // Attachments and mention chips already consume vertical keyboard space, so
    // switch the text field to internal scrolling sooner to keep the whole
    // composer card above the keyboard in compact draft screens.
    private var expandedInputMaxVisibleLines: CGFloat {
        accessoryState.hasTopAccessoryContent
            ? expandedAccessoryTextMaxVisibleLines
            : expandedPlainTextMaxVisibleLines
    }

}
