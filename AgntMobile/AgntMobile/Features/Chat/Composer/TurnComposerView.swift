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

private struct TurnComposerAutocompletePanels: View {
    let state: TurnComposerAutocompleteState
    let onSelectFileAutocomplete: (CodexFuzzyFileMatch) -> Void
    let onSelectSkillAutocomplete: (CodexSkillMetadata) -> Void
    let onSelectPluginAutocomplete: (CodexPluginMetadata) -> Void
    let onSelectSlashCommand: (TurnComposerSlashCommand) -> Void
    let onSelectCodeReviewTarget: (TurnComposerReviewTarget) -> Void
    let onSelectForkDestination: (TurnComposerForkDestination) -> Void
    let onCloseSlashCommandPanel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if state.isFileAutocompleteVisible {
                FileAutocompletePanel(
                    items: state.fileAutocompleteItems,
                    pluginItems: state.pluginAutocompleteItems,
                    isLoading: state.isFileAutocompleteLoading,
                    isLoadingPlugins: state.isPluginAutocompleteLoading,
                    query: state.fileAutocompleteQuery,
                    pluginQuery: state.pluginAutocompleteQuery,
                    onSelect: onSelectFileAutocomplete,
                    onSelectPlugin: onSelectPluginAutocomplete
                )
            }

            if !state.isFileAutocompleteVisible && state.isPluginAutocompleteVisible {
                FileAutocompletePanel(
                    items: [],
                    pluginItems: state.pluginAutocompleteItems,
                    isLoading: false,
                    isLoadingPlugins: state.isPluginAutocompleteLoading,
                    query: state.pluginAutocompleteQuery,
                    pluginQuery: state.pluginAutocompleteQuery,
                    onSelect: onSelectFileAutocomplete,
                    onSelectPlugin: onSelectPluginAutocomplete
                )
            }

            if state.isSkillAutocompleteVisible {
                SkillAutocompletePanel(
                    items: state.skillAutocompleteItems,
                    isLoading: state.isSkillAutocompleteLoading,
                    query: state.skillAutocompleteQuery,
                    trigger: state.skillAutocompleteTrigger,
                    onSelect: onSelectSkillAutocomplete
                )
            }

            if state.slashCommandPanelState != .hidden {
                SlashCommandAutocompletePanel(
                    state: state.slashCommandPanelState,
                    availableCommands: state.availableSlashCommands,
                    hasComposerContentConflictingWithReview: state.hasComposerContentConflictingWithReview,
                    isThreadRunning: state.isThreadRunning,
                    showsGitBranchSelector: state.showsGitBranchSelector,
                    isLoadingGitBranchTargets: state.isLoadingGitBranchTargets,
                    availableGitBranchTargets: state.availableGitBranchTargets,
                    selectedGitBaseBranch: state.selectedGitBaseBranch,
                    gitDefaultBranch: state.gitDefaultBranch,
                    onSelectCommand: onSelectSlashCommand,
                    onSelectReviewTarget: onSelectCodeReviewTarget,
                    onSelectForkDestination: onSelectForkDestination,
                    onClose: onCloseSlashCommandPanel
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .layoutPriority(1)
        .zIndex(1)
    }
}

private struct TurnComposerQueuedDraftsSection: View {
    let drafts: [QueuedTurnDraft]
    let canSteerDrafts: Bool
    let canRestoreDrafts: Bool
    let steeringDraftID: String?
    let onRestoreQueuedDraft: (String) -> Void
    let onSteerQueuedDraft: (String) -> Void
    let onRemoveQueuedDraft: (String) -> Void

    var body: some View {
        Group {
            if !drafts.isEmpty {
                QueuedDraftsPanel(
                    drafts: drafts,
                    canSteerDrafts: canSteerDrafts,
                    canRestoreDrafts: canRestoreDrafts,
                    steeringDraftID: steeringDraftID,
                    onRestore: onRestoreQueuedDraft,
                    onSteer: onSteerQueuedDraft,
                    onRemove: onRemoveQueuedDraft
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding([.horizontal, .bottom], 4)
                .adaptiveGlass(.regular, in: UnevenRoundedRectangle(
                    topLeadingRadius: 28,
                    bottomLeadingRadius: 0,
                    bottomTrailingRadius: 0,
                    topTrailingRadius: 28,
                    style: .continuous
                ))
                .padding(.bottom, -10)
                .padding(.horizontal, 16)
            }
        }
    }
}

private struct TurnComposerAccessorySection: View {
    let state: TurnComposerAccessoryState
    let onRemoveAttachment: (String) -> Void
    let onRemoveMentionedFile: (String) -> Void
    let onRemoveMentionedSkill: (String) -> Void
    let onRemoveMentionedPlugin: (String) -> Void
    let onRemoveComposerReviewSelection: () -> Void
    let onRemoveComposerSubagentsSelection: () -> Void

    var body: some View {
        Group {
            if state.showsComposerAttachments {
                ComposerAttachmentsPreview(
                    attachments: state.composerAttachments,
                    onRemove: onRemoveAttachment
                )
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 8)
            }

            if state.showsMentionedFiles {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(state.composerMentionedFiles) { file in
                            FileMentionChip(fileName: file.fileName) {
                                onRemoveMentionedFile(file.id)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.top, 10)
            }

            if state.showsMentionedSkills {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(state.composerMentionedSkills) { skill in
                            SkillMentionChip(skillName: skill.name) {
                                onRemoveMentionedSkill(skill.id)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }

            if state.showsMentionedPlugins {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(state.composerMentionedPlugins) { plugin in
                            PluginMentionChip(pluginName: plugin.displayName ?? plugin.name) {
                                onRemoveMentionedPlugin(plugin.id)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }

            if state.showsSubagentsSelection {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ComposerActionChip(
                            title: "Subagents",
                            symbolName: "point.3.connected.trianglepath.dotted",
                            tintColor: .teal,
                            removeAccessibilityLabel: "Remove subagents"
                        ) {
                            onRemoveComposerSubagentsSelection()
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }

            if let reviewTarget = state.reviewTarget {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ComposerActionChip(
                            title: "Code Review: \(reviewTarget.title)",
                            symbolName: "checklist",
                            tintColor: .teal,
                            removeAccessibilityLabel: "Remove code review"
                        ) {
                            onRemoveComposerReviewSelection()
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }

        }
    }
}

#Preview("Queued Drafts + Composer") {
    QueuedDraftsPanelPreviewWrapper()
}

#Preview("Composer Input - Runtime Controls") {
    ComposerInputRuntimePreviewWrapper()
}

private struct QueuedDraftsPanelPreviewWrapper: View {
    @State private var input = ""
    @State private var isInputFocused = false

    private let fakeDrafts: [QueuedTurnDraft] = [
        QueuedTurnDraft(id: "1", text: "Fix the login bug on the settings page", attachments: [], skillMentions: [], collaborationMode: nil, createdAt: .now),
        QueuedTurnDraft(id: "2", text: "Add dark mode support to the onboarding flow", attachments: [], skillMentions: [], collaborationMode: nil, createdAt: .now),
        QueuedTurnDraft(id: "3", text: "Refactor the networking layer to use async/await", attachments: [], skillMentions: [], collaborationMode: nil, createdAt: .now),
    ]

    var body: some View {
        VStack {
            Spacer()

            ComposerPreviewContent(
                input: $input,
                isInputFocused: $isInputFocused,
                queuedDrafts: fakeDrafts,
                canSteerQueuedDrafts: true,
                isSubagentsSelectionArmed: true,
                isPlanModeArmed: true,
                queuedCount: 3,
                isThreadRunning: true
            )
        }
        .safeAreaPadding(.bottom, 20)
        .background(Color(.secondarySystemBackground))
    }
}

private struct ComposerInputRuntimePreviewWrapper: View {
    @State private var input = ""
    @State private var isInputFocused = false

    var body: some View {
        VStack {
            Spacer()

            ComposerPreviewContent(
                input: $input,
                isInputFocused: $isInputFocused,
                queuedDrafts: [],
                canSteerQueuedDrafts: false,
                isSubagentsSelectionArmed: false,
                isPlanModeArmed: false,
                queuedCount: 0,
                isThreadRunning: false
            )
        }
        .safeAreaPadding(.bottom, 20)
        .background(Color(.secondarySystemBackground))
    }
}

// Shared preview fixture keeps the sample runtime controls aligned across composer previews.
private struct ComposerPreviewContent: View {
    @Binding var input: String
    @Binding var isInputFocused: Bool

    let queuedDrafts: [QueuedTurnDraft]
    let canSteerQueuedDrafts: Bool
    let isSubagentsSelectionArmed: Bool
    let isPlanModeArmed: Bool
    let queuedCount: Int
    let isThreadRunning: Bool

    private let reasoningOptions = TurnComposerMetaMapper.reasoningDisplayOptions(
        from: ["low", "medium", "high", "xhigh"]
    )

    private let modelOptions: [CodexModelOption] = [
        CodexModelOption(
            id: "gpt-5.5",
            model: "gpt-5.5",
            displayName: "GPT-5.5",
            description: "Preview model",
            isDefault: true,
            supportsFastMode: true,
            supportedReasoningEfforts: [
                CodexReasoningEffortOption(reasoningEffort: "low", description: ""),
                CodexReasoningEffortOption(reasoningEffort: "medium", description: ""),
                CodexReasoningEffortOption(reasoningEffort: "high", description: ""),
                CodexReasoningEffortOption(reasoningEffort: "xhigh", description: ""),
            ],
            defaultReasoningEffort: "high"
        ),
        CodexModelOption(
            id: "gpt-5.4",
            model: "gpt-5.4",
            displayName: "GPT-5.4",
            description: "Preview model",
            isDefault: false,
            supportsFastMode: true,
            supportedReasoningEfforts: [
                CodexReasoningEffortOption(reasoningEffort: "low", description: ""),
                CodexReasoningEffortOption(reasoningEffort: "medium", description: ""),
                CodexReasoningEffortOption(reasoningEffort: "high", description: ""),
            ],
            defaultReasoningEffort: "medium"
        ),
        CodexModelOption(
            id: "gpt-5.3-codex",
            model: "gpt-5.3-codex",
            displayName: "GPT-5.3-Codex",
            description: "Preview model",
            isDefault: false,
            supportsFastMode: false,
            supportedReasoningEfforts: [
                CodexReasoningEffortOption(reasoningEffort: "low", description: ""),
                CodexReasoningEffortOption(reasoningEffort: "medium", description: ""),
                CodexReasoningEffortOption(reasoningEffort: "high", description: ""),
            ],
            defaultReasoningEffort: "high"
        ),
        CodexModelOption(
            id: "gpt-5.2-codex",
            model: "gpt-5.2-codex",
            displayName: "GPT-5.2-Codex",
            description: "Preview model",
            isDefault: false,
            supportedReasoningEfforts: [
                CodexReasoningEffortOption(reasoningEffort: "medium", description: ""),
                CodexReasoningEffortOption(reasoningEffort: "high", description: ""),
            ],
            defaultReasoningEffort: "medium"
        ),
        CodexModelOption(
            id: "gpt-5.2",
            model: "gpt-5.2",
            displayName: "GPT-5.2",
            description: "Preview model",
            isDefault: false,
            supportedReasoningEfforts: [
                CodexReasoningEffortOption(reasoningEffort: "low", description: ""),
                CodexReasoningEffortOption(reasoningEffort: "medium", description: ""),
            ],
            defaultReasoningEffort: "medium"
        ),
        CodexModelOption(
            id: "gpt-5.1-codex-max",
            model: "gpt-5.1-codex-max",
            displayName: "GPT-5.1-Codex-Max",
            description: "Preview model",
            isDefault: false,
            supportedReasoningEfforts: [
                CodexReasoningEffortOption(reasoningEffort: "medium", description: ""),
                CodexReasoningEffortOption(reasoningEffort: "high", description: ""),
            ],
            defaultReasoningEffort: "high"
        ),
        CodexModelOption(
            id: "gpt-5.1-codex-mini",
            model: "gpt-5.1-codex-mini",
            displayName: "GPT-5.1-Codex-Mini",
            description: "Preview model",
            isDefault: false,
            supportedReasoningEfforts: [
                CodexReasoningEffortOption(reasoningEffort: "low", description: ""),
                CodexReasoningEffortOption(reasoningEffort: "medium", description: ""),
            ],
            defaultReasoningEffort: "low"
        ),
    ]

    var body: some View {
        TurnComposerView(
            input: $input,
            isInputFocused: $isInputFocused,
            accessoryState: TurnComposerAccessoryState(
                queuedDrafts: queuedDrafts,
                canSteerQueuedDrafts: canSteerQueuedDrafts,
                canRestoreQueuedDrafts: canSteerQueuedDrafts,
                steeringDraftID: nil,
                composerAttachments: [],
                composerMentionedFiles: [],
                composerMentionedSkills: [],
                composerMentionedPlugins: [],
                composerReviewSelection: nil,
                isSubagentsSelectionArmed: isSubagentsSelectionArmed,
                isPlanModeArmed: isPlanModeArmed,
                isVoiceRecording: false,
                voiceAudioLevels: [],
                voiceRecordingDuration: 0
            ),
            autocompleteState: TurnComposerAutocompleteState(
                availableSlashCommands: TurnComposerSlashCommand.allCommands,
                fileAutocompleteItems: [],
                isFileAutocompleteVisible: false,
                isFileAutocompleteLoading: false,
                fileAutocompleteQuery: "",
                skillAutocompleteItems: [],
                isSkillAutocompleteVisible: false,
                isSkillAutocompleteLoading: false,
                skillAutocompleteQuery: "",
                skillAutocompleteTrigger: "$",
                pluginAutocompleteItems: [],
                isPluginAutocompleteVisible: false,
                isPluginAutocompleteLoading: false,
                pluginAutocompleteQuery: "",
                slashCommandPanelState: .hidden,
                hasComposerContentConflictingWithReview: false,
                isThreadRunning: isThreadRunning,
                showsGitBranchSelector: false,
                isLoadingGitBranchTargets: false,
                availableGitBranchTargets: [],
                selectedGitBaseBranch: "",
                gitDefaultBranch: "main"
            ),
            remainingAttachmentSlots: 4,
            isComposerInteractionLocked: false,
            isSendDisabled: false,
            isSending: false,
            isPlanModeArmed: isPlanModeArmed,
            queuedCount: queuedCount,
            isQueuePaused: false,
            activeTurnID: nil,
            isThreadRunning: isThreadRunning,
            isEmptyThread: true,
            hasWorkingDirectory: true,
            isWorktreeProject: false,
            orderedModelOptions: modelOptions,
            selectedModelID: "gpt-5.5",
            selectedModelTitle: "GPT-5.5",
            isLoadingModels: false,
            isRuntimeSelectionLoading: false,
            runtimeState: TurnComposerRuntimeState(
                reasoningDisplayOptions: reasoningOptions,
                effectiveReasoningEffort: "high",
                selectedReasoningEffort: "high",
                reasoningMenuDisabled: false,
                selectedServiceTier: .fast,
                supportsFastMode: true
            ),
            runtimeActions: TurnComposerRuntimeActions(
                selectModel: { _ in },
                selectAutomaticReasoning: {},
                selectReasoning: { _ in },
                selectServiceTier: { _ in }
            ),
            voiceButtonPresentation: TurnComposerVoiceButtonPresentation(
                systemImageName: "mic",
                foregroundColor: Color(.secondaryLabel),
                backgroundColor: .clear,
                accessibilityLabel: "Start voice transcription",
                isDisabled: false,
                showsProgress: false,
                hasCircleBackground: false
            ),
            selectedAccessMode: .onRequest,
            contextWindowUsage: nil,
            rateLimitBuckets: [],
            isLoadingRateLimits: false,
            rateLimitsErrorMessage: nil,
            shouldAutoRefreshUsageStatus: false,
            showsGitBranchSelector: false,
            isGitBranchSelectorEnabled: false,
            availableGitBranchTargets: [],
            gitBranchesCheckedOutElsewhere: [],
            gitWorktreePathsByBranch: [:],
            selectedGitBaseBranch: "",
            currentGitBranch: "main",
            gitDefaultBranch: "main",
            isLoadingGitBranchTargets: false,
            isSwitchingGitBranch: false,
            isCreatingGitWorktree: false,
            onSelectGitBranch: { _ in },
            onCreateGitBranch: { _ in },
            onSelectGitBaseBranch: { _ in },
            onRefreshGitBranches: {},
            onRefreshUsageStatus: {},
            onResumeGoal: {},
            onPauseGoal: {},
            onRemoveGoal: {},
            onSelectAccessMode: { _ in },
            canHandOffToWorktree: false,
            onTapAddImage: {},
            onTapTakePhoto: {},
            onTapVoice: {},
            onCancelVoiceRecording: {},
            onTapCreateWorktree: {},
            onSetPlanModeArmed: { _ in },
            onRemoveAttachment: { _ in },
            onStopTurn: { _ in },
            onInputChangedForFileAutocomplete: { _ in },
            onInputChangedForSkillAutocomplete: { _ in },
            onInputChangedForPluginAutocomplete: { _ in },
            onInputChangedForSlashCommandAutocomplete: { _ in },
            onSelectFileAutocomplete: { _ in },
            onSelectSkillAutocomplete: { _ in },
            onSelectPluginAutocomplete: { _ in },
            onSelectSlashCommand: { _ in },
            onSelectCodeReviewTarget: { _ in },
            onSelectForkDestination: { _ in },
            onCloseSlashCommandPanel: {},
            onRemoveMentionedFile: { _ in },
            onRemoveMentionedSkill: { _ in },
            onRemoveMentionedPlugin: { _ in },
            onRemoveComposerReviewSelection: {},
            onRemoveComposerSubagentsSelection: {},
            onPasteImageData: { _ in },
            onResumeQueue: {},
            onRestoreQueuedDraft: { _ in },
            onSteerQueuedDraft: { _ in },
            onRemoveQueuedDraft: { _ in },
            onSend: {}
        )
    }
}
