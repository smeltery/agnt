// FILE: TurnViewModel.swift
// Purpose: Owns local TurnView state and user actions while keeping UI components lightweight.
// Layer: View Model
// Exports: TurnViewModel, TurnComposerSendAvailability, TurnComposerAttachmentIntakePlan
// Depends on: SwiftUI, Observation, PhotosUI, CodexService

import SwiftUI
import Observation
import PhotosUI

@MainActor
@Observable
final class TurnViewModel {

    init(shouldAnchorToAssistantResponse: Bool = false) {
        self.shouldAnchorToAssistantResponse = shouldAnchorToAssistantResponse
    }

    var input = ""
    var isSending = false
    var isHandlingApproval = false
    var isPlanModeArmed = false
    var steeringDraftID: String?
    var shouldAnchorToAssistantResponse = false
    var isPhotoPickerPresented = false
    var isCameraPresented = false
    var photoPickerItems: [PhotosPickerItem] = []
    var composerAttachments: [TurnComposerImageAttachment] = []
    var composerMentionedFiles: [TurnComposerMentionedFile] = []
    var composerMentionedSkills: [TurnComposerMentionedSkill] = []
    var composerMentionedPlugins: [TurnComposerMentionedPlugin] = []
    var composerReviewSelection: TurnComposerReviewSelection?
    var isSubagentsSelectionArmed = false
    var fileAutocompleteItems: [CodexFuzzyFileMatch] = []
    var isFileAutocompleteVisible = false
    var isFileAutocompleteLoading = false
    var fileAutocompleteQuery = ""
    var skillAutocompleteItems: [CodexSkillMetadata] = []
    var isSkillAutocompleteVisible = false
    var isSkillAutocompleteLoading = false
    var skillAutocompleteQuery = ""
    var skillAutocompleteTrigger = "$"
    var pluginAutocompleteItems: [CodexPluginMetadata] = []
    var isPluginAutocompleteVisible = false
    var isPluginAutocompleteLoading = false
    var pluginAutocompleteQuery = ""
    var slashCommandPanelState: TurnComposerSlashCommandPanelState = .hidden
    // MARK: - Git state

    var runningGitAction: TurnGitActionKind? = nil
    var gitActionLoadingTitle: String? = nil
    var inlineCommitAndPushPhase: InlineCommitAndPushPhase? = nil
    var isShowingNothingToCommitAlert = false
    var gitSyncAlert: TurnGitSyncAlert? = nil
    var isLoadingGitBranchTargets = false
    var isSwitchingGitBranch = false
    var isCreatingGitWorktree = false
    var selectedGitBaseBranch = ""
    var currentGitBranch = ""
    var availableGitBranchTargets: [String] = []
    var gitBranchesCheckedOutElsewhere: Set<String> = []
    var gitWorktreePathsByBranch: [String: String] = [:]
    var gitLocalCheckoutPath: String?
    var gitDefaultBranch = ""
    var gitRepoSync: GitRepoSyncResult? = nil

    // Cached projected timeline to avoid re-running TurnTimelineReducer on every SwiftUI evaluation.
    var projectedMessages: [CodexMessage] = []
    @ObservationIgnored var threadActivationTask: Task<Void, Never>?

    @ObservationIgnored var fileAutocompleteDebounceTask: Task<Void, Never>?
    @ObservationIgnored var skillAutocompleteDebounceTask: Task<Void, Never>?
    @ObservationIgnored var pluginAutocompleteDebounceTask: Task<Void, Never>?
    @ObservationIgnored var localDraftPersistenceDebounceTask: Task<Void, Never>?
    @ObservationIgnored var gitStatusRefreshTask: Task<Void, Never>?
    @ObservationIgnored var pendingGitBranchOperation: GitBranchUserOperation?
    @ObservationIgnored var pendingGitWorktreeOpenHandler: ((GitCreateWorktreeResult) -> Void)?
    @ObservationIgnored var pendingManagedGitWorktreeOpenHandler: ((GitCreateManagedWorktreeResult) -> Void)?
    @ObservationIgnored var cachedSkillSearchIndexByRoot: [String: [TurnSkillSearchIndexEntry]] = [:]
    @ObservationIgnored var forceRefreshedSkillMissKeys: Set<String> = []
    @ObservationIgnored var cachedPluginSearchIndexByRoot: [String: [TurnPluginSearchIndexEntry]] = [:]
    @ObservationIgnored var unsupportedSkillsAutocompleteRoots: Set<String> = []
    @ObservationIgnored var unsupportedPluginsAutocompleteRoots: Set<String> = []
    @ObservationIgnored var dismissedStructuredPlanPromptRequestKeys: Set<String> = []
    @ObservationIgnored var dismissingStructuredPlanPromptRequestKeys: Set<String> = []
    @ObservationIgnored var attachmentLoadTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored var detachedAttachmentLoadIDs: Set<String> = []

    let maxComposerImages = 4
    let maxFileAutocompleteItems = 6
    let maxSkillAutocompleteItems = 6
    let maxPluginAutocompleteItems = 6
    let fileAutocompleteDebounceNanoseconds: UInt64 = 180_000_000
    let skillAutocompleteDebounceNanoseconds: UInt64 = 180_000_000
    let pluginAutocompleteDebounceNanoseconds: UInt64 = 180_000_000
    let localDraftPersistenceDebounceNanoseconds: UInt64 = 650_000_000
    let gitStatusRefreshDebounceNanoseconds: UInt64 = 350_000_000

    init() {}

    @ObservationIgnored var lastProjectedThreadID: String?
    @ObservationIgnored var lastProjectionChangeToken: Int = -1

    nonisolated static func loadComposerAttachmentState(from item: PhotosPickerItem) async -> TurnComposerImageAttachmentState {
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  !data.isEmpty else {
                return .failed
            }
            return await loadComposerAttachmentState(fromData: data)
        } catch {
            return .failed
        }
    }

    nonisolated static func loadComposerAttachmentState(fromData data: Data) async -> TurnComposerImageAttachmentState {
        guard let attachment = TurnAttachmentPipeline.makeAttachment(from: data) else {
            return .failed
        }
        return .ready(attachment)
    }

    static func isMethodNotFoundRPCError(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        return message.contains("method not found")
            || message.contains("unsupported")
            || message.contains("code -32601")
    }


}
