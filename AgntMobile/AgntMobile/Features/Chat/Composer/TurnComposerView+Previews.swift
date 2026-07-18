// FILE: TurnComposerView+Previews.swift
// Purpose: Preview fixtures for the turn composer.
// Layer: Preview support
// Exports: SwiftUI previews
// Depends on: SwiftUI, TurnComposerView

import SwiftUI

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
            onEditGoal: {},
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
