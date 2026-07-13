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
    enum GitBranchUserOperation: Equatable {
        case create(String)
        case switchTo(String)
        case createWorktree(
            branchName: String,
            baseBranch: String,
            changeTransfer: GitWorktreeChangeTransferMode
        )
        case createManagedWorktree(
            baseBranch: String,
            changeTransfer: GitWorktreeChangeTransferMode
        )
    }

    // Preserves the exact composer payload + raw chips so stale-busy recovery can retry cleanly.
    private struct PendingTurnSend {
        let payload: String
        let attachments: [CodexImageAttachment]
        let skillMentions: [CodexTurnSkillMention]
        let mentionMentions: [CodexTurnMention]
        let collaborationMode: CodexCollaborationModeKind?
        let rawInput: String
        let rawFileMentions: [TurnComposerMentionedFile]
        let rawSkillMentions: [TurnComposerMentionedSkill]
        let rawPluginMentions: [TurnComposerMentionedPlugin]
        let rawAttachments: [TurnComposerImageAttachment]
        let rawReviewSelection: TurnComposerReviewSelection?
        let rawSubagentsSelectionArmed: Bool
    }

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
    var isRunningGitAction: Bool { runningGitAction != nil }
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
    var gitSyncState: String? { gitRepoSync?.state }
    var isGitRepositoryInitialized: Bool { gitRepoSync?.isGitRepository == true }
    var disabledGitActions: Set<TurnGitActionKind> {
        var disabledActions: Set<TurnGitActionKind> = []
        if !canCreatePullRequest {
            disabledActions.insert(.createPR)
        }
        if !canCommitPushCreatePullRequest {
            disabledActions.insert(.commitPushCreatePR)
        }
        if gitRepoSync?.canPush != true {
            disabledActions.insert(.push)
        }
        if gitRepoSync?.hasPushRemote != true || !(gitRepoSync?.isDirty == true || gitRepoSync?.canPush == true) {
            disabledActions.insert(.commitAndPush)
        }
        if !canUpdateRepositoryFromRemote {
            disabledActions.insert(.syncNow)
        }
        return disabledActions
    }
    var canUpdateRepositoryFromRemote: Bool {
        guard let repoSync = gitRepoSync, repoSync.isGitRepository else {
            return false
        }

        // Normal Update is only for fast-forwardable remote work. Diverged branches
        // stay disabled here so the user must choose an explicit rebase/merge path.
        return ["behind_only", "dirty_and_behind"].contains(repoSync.state)
    }
    // Keeps PR creation tied to live Git state instead of chat-local remembered branch state.
    var createPullRequestValidationMessage: String? {
        guard let repoSync = gitRepoSync else {
            return "Git status is still loading. Wait a moment and retry."
        }

        let branch = (repoSync.currentBranch ?? currentGitBranch).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !branch.isEmpty else {
            return "No current branch found."
        }

        let defaultBranch = gitDefaultBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !defaultBranch.isEmpty else {
            return "Could not determine the repository default branch."
        }

        guard branch != defaultBranch else {
            return "Switch to a feature branch before creating a PR."
        }

        guard !repoSync.isDirty else {
            return "Commit local changes before creating a PR."
        }

        guard repoSync.hasPushRemote else {
            return "Add a Git remote before creating a PR."
        }

        guard repoSync.behindCount == 0 else {
            return "Pull remote changes before creating a PR."
        }

        return nil
    }
    var canCreatePullRequest: Bool { createPullRequestValidationMessage == nil }
    var canCommitPushCreatePullRequest: Bool {
        guard let repoSync = gitRepoSync, repoSync.isGitRepository else {
            return false
        }

        let branch = (repoSync.currentBranch ?? currentGitBranch).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !branch.isEmpty,
              !gitDefaultBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              repoSync.hasPushRemote,
              repoSync.behindCount == 0
        else {
            return false
        }

        return repoSync.isDirty || repoSync.aheadCount > 0 || !repoSync.isPublishedToRemote
    }
    var localSelectableGitDefaultBranch: String? {
        agntSelectableDefaultBranch(
            defaultBranch: gitDefaultBranch,
            availableGitBranchTargets: availableGitBranchTargets
        )
    }
    var shouldShowDiscardRuntimeChangesAndSync: Bool {
        guard let sync = gitRepoSync else { return false }
        let dangerousStates = ["dirty", "dirty_and_behind", "diverged"]
        return dangerousStates.contains(sync.state) || (sync.isDirty && sync.state == "no_upstream")
    }

    // Keeps git mutations scoped to an explicitly bound local repo. Repo-level
    // write actions can opt out of the idle-turn gate; branch/worktree routing keeps it.
    func canRunGitAction(
        isConnected: Bool,
        isThreadRunning: Bool,
        hasGitWorkingDirectory: Bool,
        requiresIdleThread: Bool = true
    ) -> Bool {
        isConnected
            && hasGitWorkingDirectory
            && (!requiresIdleThread || !isThreadRunning)
            && !isRunningGitAction
            && !isSwitchingGitBranch
            && !isCreatingGitWorktree
    }

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
    @ObservationIgnored private var cachedSkillSearchIndexByRoot: [String: [TurnSkillSearchIndexEntry]] = [:]
    @ObservationIgnored private var forceRefreshedSkillMissKeys: Set<String> = []
    @ObservationIgnored private var cachedPluginSearchIndexByRoot: [String: [TurnPluginSearchIndexEntry]] = [:]
    @ObservationIgnored var unsupportedSkillsAutocompleteRoots: Set<String> = []
    @ObservationIgnored var unsupportedPluginsAutocompleteRoots: Set<String> = []
    @ObservationIgnored private var dismissedStructuredPlanPromptRequestKeys: Set<String> = []
    @ObservationIgnored private var dismissingStructuredPlanPromptRequestKeys: Set<String> = []
    @ObservationIgnored var attachmentLoadTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored var detachedAttachmentLoadIDs: Set<String> = []

    let maxComposerImages = 4
    let maxFileAutocompleteItems = 6
    let maxSkillAutocompleteItems = 6
    let maxPluginAutocompleteItems = 6
    private let fileAutocompleteDebounceNanoseconds: UInt64 = 180_000_000
    private let skillAutocompleteDebounceNanoseconds: UInt64 = 180_000_000
    private let pluginAutocompleteDebounceNanoseconds: UInt64 = 180_000_000
    let localDraftPersistenceDebounceNanoseconds: UInt64 = 650_000_000
    let gitStatusRefreshDebounceNanoseconds: UInt64 = 350_000_000

    init() {}

    @ObservationIgnored var lastProjectedThreadID: String?
    @ObservationIgnored var lastProjectionChangeToken: Int = -1

    // Normalized composer input reused by send validation and turn creation.
    var trimmedComposerInput: String {
        input.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // Any loading/failed attachment must block send to avoid partial payloads.
    var hasBlockingAttachmentState: Bool {
        composerAttachments.contains(where: { $0.state == .loading || $0.state == .failed })
    }

    var readyComposerAttachments: [CodexImageAttachment] {
        composerAttachments.compactMap { attachment in
            if case .ready(let value) = attachment.state {
                return value
            }
            return nil
        }
    }

    var hasReadyImages: Bool {
        !readyComposerAttachments.isEmpty
    }

    var hasComposerReviewSelection: Bool {
        composerReviewSelection?.target != nil
    }

    // Keeps queue restore disabled whenever the composer already contains something meaningful.
    var hasComposerDraftContent: Bool {
        !trimmedComposerInput.isEmpty
            || !composerAttachments.isEmpty
            || !composerMentionedFiles.isEmpty
            || !composerMentionedSkills.isEmpty
            || !composerMentionedPlugins.isEmpty
            || composerReviewSelection != nil
            || isSubagentsSelectionArmed
            || isPlanModeArmed
    }

    // Allows only one queued row at a time to move back into the composer.
    var canRestoreQueuedDrafts: Bool {
        !isSending
            && steeringDraftID == nil
            && !hasComposerDraftContent
    }

    var hasPendingComposerReviewSelection: Bool {
        composerReviewSelection != nil && composerReviewSelection?.target == nil
    }

    var hasComposerContentConflictingWithReview: Bool {
        TurnComposerCommandLogic.hasContentConflictingWithReview(
            trimmedInput: trimmedComposerInput,
            mentionedFileCount: composerMentionedFiles.count,
            mentionedSkillCount: composerMentionedSkills.count,
            attachmentCount: composerAttachments.count,
            hasSubagentsSelection: isSubagentsSelectionArmed
        )
    }

    func queuedCount(codex: CodexService, threadID: String) -> Int {
        queuedDrafts(codex: codex, threadID: threadID).count
    }

    func isQueuePaused(codex: CodexService, threadID: String) -> Bool {
        if case .paused = queuePauseState(codex: codex, threadID: threadID) {
            return true
        }
        return false
    }

    func queuedDraftsList(codex: CodexService, threadID: String) -> [QueuedTurnDraft] {
        queuedDrafts(codex: codex, threadID: threadID)
    }

    func removeQueuedDraft(
        id: String,
        codex: CodexService,
        threadID: String,
        removeOptimisticMessage: Bool = true
    ) {
        var drafts = queuedDrafts(codex: codex, threadID: threadID)
        let removedDraft = drafts.first { $0.id == id }
        drafts.removeAll { $0.id == id }
        setQueuedDrafts(drafts, codex: codex, threadID: threadID)
        if removeOptimisticMessage {
            removeQueuedDraftOptimisticMessageIfNeeded(removedDraft, codex: codex, threadID: threadID)
        }
    }

    // Moves one queued row back into the composer so the user can edit/resend it manually.
    func restoreQueuedDraftToComposer(id: String, codex: CodexService, threadID: String) {
        guard canRestoreQueuedDrafts else {
            return
        }

        var drafts = queuedDrafts(codex: codex, threadID: threadID)
        guard let draftIndex = drafts.firstIndex(where: { $0.id == id }) else {
            return
        }

        let draft = drafts.remove(at: draftIndex)
        setQueuedDrafts(drafts, codex: codex, threadID: threadID)
        removeQueuedDraftOptimisticMessageIfNeeded(draft, codex: codex, threadID: threadID)
        restoreComposerState(from: draft)
        clearComposerAutocomplete()
        shouldAnchorToAssistantResponse = false
    }

    func isSteeringQueuedDraft(_ draftID: String) -> Bool {
        steeringDraftID == draftID
    }

    func queuePauseMessage(codex: CodexService, threadID: String) -> String? {
        if case .paused(let errorMessage) = queuePauseState(codex: codex, threadID: threadID) {
            return errorMessage
        }
        return nil
    }

    func isComposerInteractionLocked(activeTurnID: String?) -> Bool {
        _ = activeTurnID
        return isSending
    }

    func isSendDisabled(isConnected: Bool, activeTurnID: String?) -> Bool {
        _ = activeTurnID
        return TurnComposerSendAvailability(
            isSending: isSending,
            isConnected: isConnected,
            trimmedInput: trimmedComposerInput,
            hasReadyImages: hasReadyImages,
            hasBlockingAttachmentState: hasBlockingAttachmentState,
            hasSkillSelection: !composerMentionedSkills.isEmpty,
            hasPluginSelection: !composerMentionedPlugins.isEmpty,
            hasReviewSelection: hasComposerReviewSelection,
            hasPendingReviewSelection: hasPendingComposerReviewSelection,
            hasSubagentsSelection: isSubagentsSelectionArmed
        ).isSendDisabled
    }

    func clearComposer() {
        resetFileAutocompleteState()
        resetSkillAutocompleteState()
        resetPluginAutocompleteState()
        resetSlashCommandState(clearPendingSelection: true, clearConfirmedSelection: true)
        isSubagentsSelectionArmed = false
        input = ""
        cancelAttachmentLoadTasks()
        detachedAttachmentLoadIDs.removeAll()
        composerAttachments.removeAll()
        composerMentionedFiles.removeAll()
        composerMentionedSkills.removeAll()
        composerMentionedPlugins.removeAll()
    }

    // Appends spoken text into the composer without sending it automatically.
    func appendVoiceTranscript(_ transcript: String) {
        let normalizedTranscript = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedTranscript.isEmpty else {
            return
        }

        if input.isEmpty {
            input = normalizedTranscript
            return
        }

        if input.last?.isWhitespace == true {
            input += normalizedTranscript
        } else {
            input += " \(normalizedTranscript)"
        }
    }

    func setPlanModeArmed(_ isArmed: Bool) {
        isPlanModeArmed = isArmed
    }

    func clearFileAutocomplete() {
        resetFileAutocompleteState()
    }

    func clearSkillAutocomplete() {
        resetSkillAutocompleteState()
    }

    func clearPluginAutocomplete() {
        resetPluginAutocompleteState()
    }

    func clearComposerAutocomplete() {
        resetFileAutocompleteState()
        resetSkillAutocompleteState()
        resetPluginAutocompleteState()
        resetSlashCommandState(clearPendingSelection: true)
    }

    // Dismisses only the transient slash-command picker without touching confirmed composer chips.
    func closeSlashCommandPanel() {
        resetSlashCommandState(clearPendingSelection: true)
    }

    // Clears the transient slash token before routing the user into another composer flow.
    func prepareForThreadRerouteFromSlashCommand() {
        removeTrailingSlashCommandTokenFromInputIfNeeded()
        resetSlashCommandState(clearPendingSelection: true)
    }

    // Applies one-shot composer state that a fresh thread should show on first open.
    func applyPendingComposerAction(_ action: CodexPendingThreadComposerAction) {
        switch action {
        case .codeReview(let target):
            armCodeReviewSelection(
                command: .codeReview,
                target: Self.turnComposerReviewTarget(for: target)
            )
        }
    }

    // Debounces server-side fuzzy search when input ends with a valid `@query` token.
    func onInputChangedForFileAutocomplete(
        _ text: String,
        codex: CodexService,
        thread: CodexThread,
        activeTurnID: String?
    ) {
        guard !isComposerInteractionLocked(activeTurnID: activeTurnID),
              codex.isConnected,
              let root = normalizedAutocompleteRoot(for: thread),
              let token = Self.trailingFileAutocompleteToken(in: text) else {
            resetFileAutocompleteState()
            return
        }

        // Keeps a confirmed `@file` mention closed once the user resumes normal prose after it.
        guard !Self.hasClosedConfirmedFileMentionPrefix(
            in: text,
            confirmedMentions: composerMentionedFiles
        ) else {
            resetFileAutocompleteState()
            return
        }

        // Keep one autocomplete namespace visible at a time.
        resetSkillAutocompleteState()
        resetSlashCommandState(clearPendingSelection: true)

        let query = token.query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.count >= 1 else {
            fileAutocompleteDebounceTask?.cancel()
            fileAutocompleteDebounceTask = nil
            fileAutocompleteItems = []
            fileAutocompleteQuery = query
            isFileAutocompleteLoading = false
            isFileAutocompleteVisible = false
            return
        }

        fileAutocompleteQuery = query
        isFileAutocompleteVisible = true
        isFileAutocompleteLoading = true
        fileAutocompleteDebounceTask?.cancel()

        let searchRoots = [root]
        let expectedQuery = query
        let cancellationToken = fileAutocompleteCancellationToken(for: thread.id)

        fileAutocompleteDebounceTask = Task { @MainActor [weak self] in
            guard let self else { return }

            do {
                try await Task.sleep(nanoseconds: fileAutocompleteDebounceNanoseconds)
            } catch {
                return
            }

            guard !Task.isCancelled else { return }

            do {
                let matches = try await codex.fuzzyFileSearch(
                    query: expectedQuery,
                    roots: searchRoots,
                    cancellationToken: cancellationToken
                )
                guard !Task.isCancelled else { return }

                // Drops stale responses if the user already typed another query.
                guard self.fileAutocompleteQuery == expectedQuery else { return }

                self.fileAutocompleteItems = Array(matches.prefix(self.maxFileAutocompleteItems))
                self.isFileAutocompleteLoading = false
                self.isFileAutocompleteVisible = true
            } catch {
                guard self.fileAutocompleteQuery == expectedQuery else { return }
                self.fileAutocompleteItems = []
                self.isFileAutocompleteLoading = false
                self.isFileAutocompleteVisible = false
            }
        }
    }

    // Debounces skill suggestions when input ends with a valid `$query` token.
    func onInputChangedForSkillAutocomplete(
        _ text: String,
        codex: CodexService,
        thread: CodexThread,
        activeTurnID: String?
    ) {
        guard !isComposerInteractionLocked(activeTurnID: activeTurnID),
              codex.isConnected,
              let token = Self.trailingSkillAutocompleteToken(in: text) else {
            resetSkillAutocompleteState()
            return
        }

        // Keep one autocomplete namespace visible at a time.
        resetFileAutocompleteState()
        resetPluginAutocompleteState()
        resetSlashCommandState(clearPendingSelection: true)

        let query = token.query.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedRoot = normalizedAutocompleteRoot(for: thread)
        let cacheKey = autocompleteCacheKey(forRoot: normalizedRoot)
        skillAutocompleteQuery = query
        skillAutocompleteTrigger = String(token.trigger)
        let hasCachedSkillIndex = cachedSkillSearchIndexByRoot[cacheKey] != nil
        let rootIsUnsupported = unsupportedSkillsAutocompleteRoots.contains(cacheKey)
        isSkillAutocompleteLoading = !hasCachedSkillIndex && !rootIsUnsupported
        if let cachedIndex = cachedSkillSearchIndexByRoot[cacheKey] {
            skillAutocompleteItems = filteredSkillAutocompleteItems(for: query, indexedSkills: cachedIndex)
            let shouldRefreshCachedMiss = shouldRefreshSkillAutocompleteMiss(
                query: query,
                cachedItems: skillAutocompleteItems,
                cacheKey: cacheKey
            )
            isSkillAutocompleteLoading = shouldRefreshCachedMiss
            isSkillAutocompleteVisible = !skillAutocompleteItems.isEmpty || shouldRefreshCachedMiss
        } else {
            skillAutocompleteItems = []
            isSkillAutocompleteVisible = isSkillAutocompleteLoading
        }
        skillAutocompleteDebounceTask?.cancel()

        let expectedQuery = query

        skillAutocompleteDebounceTask = Task { @MainActor [weak self] in
            guard let self else { return }

            do {
                try await Task.sleep(nanoseconds: skillAutocompleteDebounceNanoseconds)
            } catch {
                return
            }

            guard !Task.isCancelled else { return }

            do {
                if unsupportedSkillsAutocompleteRoots.contains(cacheKey),
                   cachedSkillSearchIndexByRoot[cacheKey] == nil {
                    guard self.skillAutocompleteQuery == expectedQuery else { return }
                    self.skillAutocompleteItems = []
                    self.isSkillAutocompleteLoading = false
                    self.isSkillAutocompleteVisible = false
                    return
                }

                let indexedSkills: [TurnSkillSearchIndexEntry]
                if let cachedIndex = self.cachedSkillSearchIndexByRoot[cacheKey] {
                    let cachedItems = self.filteredSkillAutocompleteItems(
                        for: expectedQuery,
                        indexedSkills: cachedIndex
                    )
                    if self.shouldRefreshSkillAutocompleteMiss(
                        query: expectedQuery,
                        cachedItems: cachedItems,
                        cacheKey: cacheKey
                    ) {
                        let listedSkills = try await codex.listSkills(
                            cwds: normalizedRoot.map { [$0] },
                            forceReload: true
                        )
                        guard !Task.isCancelled else { return }
                        indexedSkills = listedSkills
                            .filter { $0.enabled }
                            .map(TurnSkillSearchIndexEntry.init(skill:))
                        self.cachedSkillSearchIndexByRoot[cacheKey] = indexedSkills
                        self.rememberSkillAutocompleteMissRefresh(
                            query: expectedQuery,
                            cacheKey: cacheKey,
                            indexedSkills: indexedSkills
                        )
                    } else {
                        indexedSkills = cachedIndex
                    }
                } else {
                    let listedSkills = try await codex.listSkills(
                        cwds: normalizedRoot.map { [$0] },
                        forceReload: false
                    )
                    guard !Task.isCancelled else { return }
                    indexedSkills = listedSkills
                        .filter { $0.enabled }
                        .map(TurnSkillSearchIndexEntry.init(skill:))
                    self.cachedSkillSearchIndexByRoot[cacheKey] = indexedSkills
                    self.clearSkillAutocompleteMissRefreshes(cacheKey: cacheKey)
                }

                guard !Task.isCancelled else { return }
                guard self.skillAutocompleteQuery == expectedQuery else { return }

                self.skillAutocompleteItems = self.filteredSkillAutocompleteItems(
                    for: expectedQuery,
                    indexedSkills: indexedSkills
                )
                self.isSkillAutocompleteLoading = false
                self.isSkillAutocompleteVisible = !self.skillAutocompleteItems.isEmpty
            } catch {
                guard self.skillAutocompleteQuery == expectedQuery else { return }

                if Self.isMethodNotFoundRPCError(error) {
                    self.unsupportedSkillsAutocompleteRoots.insert(cacheKey)
                }

                self.skillAutocompleteItems = []
                self.isSkillAutocompleteLoading = false
                self.isSkillAutocompleteVisible = false
            }
        }
    }

    // Debounces installed Codex plugin suggestions for `@plugin` composer mentions.
    func onInputChangedForPluginAutocomplete(
        _ text: String,
        codex: CodexService,
        thread: CodexThread,
        activeTurnID: String?
    ) {
        guard !isComposerInteractionLocked(activeTurnID: activeTurnID),
              codex.isConnected,
              let root = normalizedAutocompleteRoot(for: thread),
              let token = Self.trailingPluginAutocompleteToken(in: text) else {
            resetPluginAutocompleteState()
            return
        }

        resetSkillAutocompleteState()
        resetSlashCommandState(clearPendingSelection: true)

        let query = token.query.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedRoot = root
        pluginAutocompleteQuery = query
        isPluginAutocompleteVisible = true
        let hasCachedPluginIndex = cachedPluginSearchIndexByRoot[normalizedRoot] != nil
        let rootIsUnsupported = unsupportedPluginsAutocompleteRoots.contains(normalizedRoot)
        isPluginAutocompleteLoading = !hasCachedPluginIndex && !rootIsUnsupported
        if let cachedIndex = cachedPluginSearchIndexByRoot[normalizedRoot] {
            pluginAutocompleteItems = filteredPluginAutocompleteItems(for: query, indexedPlugins: cachedIndex)
            isPluginAutocompleteVisible = !pluginAutocompleteItems.isEmpty
        } else {
            pluginAutocompleteItems = []
        }
        pluginAutocompleteDebounceTask?.cancel()

        let expectedQuery = query

        pluginAutocompleteDebounceTask = Task { @MainActor [weak self] in
            guard let self else { return }

            do {
                try await Task.sleep(nanoseconds: pluginAutocompleteDebounceNanoseconds)
            } catch {
                return
            }

            guard !Task.isCancelled else { return }

            do {
                if unsupportedPluginsAutocompleteRoots.contains(normalizedRoot),
                   cachedPluginSearchIndexByRoot[normalizedRoot] == nil {
                    guard self.pluginAutocompleteQuery == expectedQuery else { return }
                    self.pluginAutocompleteItems = []
                    self.isPluginAutocompleteLoading = false
                    self.isPluginAutocompleteVisible = false
                    return
                }

                let indexedPlugins: [TurnPluginSearchIndexEntry]
                if let cachedIndex = self.cachedPluginSearchIndexByRoot[normalizedRoot] {
                    indexedPlugins = cachedIndex
                } else {
                    let listedPlugins = try await codex.listPlugins(cwds: [normalizedRoot], forceReload: false)
                    guard !Task.isCancelled else { return }
                    indexedPlugins = listedPlugins
                        .map(TurnPluginSearchIndexEntry.init(plugin:))
                    self.cachedPluginSearchIndexByRoot[normalizedRoot] = indexedPlugins
                }

                guard !Task.isCancelled else { return }
                guard self.pluginAutocompleteQuery == expectedQuery else { return }

                self.pluginAutocompleteItems = self.filteredPluginAutocompleteItems(
                    for: expectedQuery,
                    indexedPlugins: indexedPlugins
                )
                self.isPluginAutocompleteLoading = false
                self.isPluginAutocompleteVisible = !self.pluginAutocompleteItems.isEmpty
            } catch {
                guard self.pluginAutocompleteQuery == expectedQuery else { return }

                if Self.isMethodNotFoundRPCError(error) {
                    self.unsupportedPluginsAutocompleteRoots.insert(normalizedRoot)
                }

                self.pluginAutocompleteItems = []
                self.isPluginAutocompleteLoading = false
                self.isPluginAutocompleteVisible = false
            }
        }
    }

    // Replaces `@query` with `@filename` in text and adds chip above input.
    func onSelectFileAutocomplete(_ item: CodexFuzzyFileMatch) {
        clearComposerReviewSelectionIfNeededForNonReviewContent()

        let fullPath = item.path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? item.fileName
            : item.path

        // Replace @query with @filename inline in the text.
        if let updatedInput = Self.replacingTrailingFileAutocompleteToken(
            in: input, with: item.fileName
        ) {
            input = updatedInput
        }

        if !composerMentionedFiles.contains(where: { $0.path == fullPath }) {
            composerMentionedFiles.append(
                TurnComposerMentionedFile(fileName: item.fileName, path: fullPath)
            )
        }
        resetFileAutocompleteState()
    }

    // Replaces `@query` with `@plugin` and stores the app-server mention item for turn/start.
    func onSelectPluginAutocomplete(_ plugin: CodexPluginMetadata) {
        clearComposerReviewSelectionIfNeededForNonReviewContent()

        let normalizedPluginName = plugin.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedMentionPath = plugin.mentionPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedPluginName.isEmpty, !normalizedMentionPath.isEmpty else {
            resetPluginAutocompleteState()
            return
        }

        if let updatedInput = Self.replacingTrailingPluginAutocompleteToken(
            in: input,
            with: normalizedPluginName
        ) {
            input = updatedInput
        }

        if !composerMentionedPlugins.contains(where: { $0.path == normalizedMentionPath }) {
            composerMentionedPlugins.append(
                TurnComposerMentionedPlugin(
                    name: normalizedPluginName,
                    path: normalizedMentionPath,
                    displayName: plugin.displayName
                )
            )
        }

        resetPluginAutocompleteState()
    }

    // Replaces `$query` or `/query` with the selected skill token and stores the turn/start mention.
    func onSelectSkillAutocomplete(_ skill: CodexSkillMetadata) {
        clearComposerReviewSelectionIfNeededForNonReviewContent()

        let normalizedSkillName = skill.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedSkillName.isEmpty else {
            resetSkillAutocompleteState()
            return
        }

        if let updatedInput = Self.replacingTrailingSkillAutocompleteToken(
            in: input, with: normalizedSkillName
        ) {
            input = updatedInput
        }

        let normalizedPath = skill.path?.trimmingCharacters(in: .whitespacesAndNewlines)
        if !composerMentionedSkills.contains(where: { $0.name.caseInsensitiveCompare(normalizedSkillName) == .orderedSame }) {
            composerMentionedSkills.append(
                TurnComposerMentionedSkill(
                    name: normalizedSkillName,
                    path: (normalizedPath?.isEmpty == false) ? normalizedPath : nil,
                    description: skill.description
                )
            )
        }

        resetSkillAutocompleteState()
    }

    // Keeps `/` command discovery separate from @/$ autocomplete while supporting a bare trailing slash.
    func onInputChangedForSlashCommandAutocomplete(
        _ text: String,
        activeTurnID: String?
    ) {
        clearComposerReviewSelectionIfNeededForInput(text)

        guard !isComposerInteractionLocked(activeTurnID: activeTurnID) else {
            resetSlashCommandState(clearPendingSelection: true)
            return
        }

        switch slashCommandPanelState {
        case .codeReviewTargets, .forkDestinations:
            return
        case .hidden, .commands:
            break
        }

        guard let token = Self.trailingSlashCommandToken(in: text) else {
            if case .commands = slashCommandPanelState {
                resetSlashCommandState()
            }
            return
        }

        let matchingCommands = TurnComposerSlashCommand.filtered(matching: token.query)
        guard token.query.isEmpty || !matchingCommands.isEmpty else {
            if case .commands = slashCommandPanelState {
                resetSlashCommandState()
            }
            return
        }

        resetFileAutocompleteState()
        resetSkillAutocompleteState()
        resetPluginAutocompleteState()
        slashCommandPanelState = .commands(query: token.query)
    }

    // Turns the selected slash command into the matching inline composer behavior.
    func onSelectSlashCommand(
        _ command: TurnComposerSlashCommand,
        availableForkDestinations: [TurnComposerForkDestination] = [.local]
    ) {
        switch command {
        case .codeReview:
            removeTrailingSlashCommandTokenFromInputIfNeeded()
            armCodeReviewSelection(command: command, target: nil)
        case .feedback:
            removeTrailingSlashCommandTokenFromInputIfNeeded()
            resetSlashCommandState(clearPendingSelection: true)
        case .fork:
            slashCommandPanelState = .forkDestinations(availableForkDestinations)
        case .goal:
            removeTrailingSlashCommandTokenFromInputIfNeeded()
            resetSlashCommandState(clearPendingSelection: true)
        case .status:
            removeTrailingSlashCommandTokenFromInputIfNeeded()
            resetSlashCommandState(clearPendingSelection: true)
        case .subagents:
            armSubagentsSelection()
        case .compact:
            removeTrailingSlashCommandTokenFromInputIfNeeded()
            resetSlashCommandState(clearPendingSelection: true)
        }
    }

    func onSelectCodeReviewTarget(_ target: TurnComposerReviewTarget) {
        removeTrailingSlashCommandTokenFromInputIfNeeded()
        armCodeReviewSelection(command: .codeReview, target: target)
    }

    // Keeps slash token cleanup and submenu dismissal consistent before a fork flow reroutes threads.
    func onSelectForkDestination(_ destination: TurnComposerForkDestination) {
        prepareForThreadRerouteFromSlashCommand()
    }

    func clearComposerReviewSelection() {
        composerReviewSelection = nil
        resetSlashCommandState()
    }

    func clearSubagentsSelection() {
        isSubagentsSelectionArmed = false
        resetSlashCommandState(clearPendingSelection: true)
    }

    func removeMentionedFile(id: String) {
        if let mention = composerMentionedFiles.first(where: { $0.id == id }) {
            let ambiguousKeys = Self.ambiguousFileNameAliasKeys(in: composerMentionedFiles)
            let collisionKey = Self.fileNameAliasCollisionKey(for: mention.fileName)
            let allowFileNameAliases = collisionKey.map { !ambiguousKeys.contains($0) } ?? true
            input = Self.removingFileMentionAliases(
                for: mention,
                from: input,
                allowFileNameAliases: allowFileNameAliases
            )
        }
        composerMentionedFiles.removeAll(where: { $0.id == id })
    }

    func removeMentionedSkill(id: String) {
        if let mention = composerMentionedSkills.first(where: { $0.id == id }) {
            input = Self.removeBoundedToken("$\(mention.name)", from: input)
            input = Self.removeBoundedToken("/\(mention.name)", from: input)
        }
        composerMentionedSkills.removeAll(where: { $0.id == id })
    }

    func removeMentionedPlugin(id: String) {
        if let mention = composerMentionedPlugins.first(where: { $0.id == id }) {
            input = Self.removeBoundedToken("@\(mention.name)", from: input)
        }
        composerMentionedPlugins.removeAll(where: { $0.id == id })
    }

    // Sends a composer payload, queueing follow-ups while the current run is still active.
    func sendTurn(
        codex: CodexService,
        threadID: String
    ) {
        guard let pendingSend = buildValidatedPendingSend(codex: codex) else {
            return
        }

        let initialQueuedDraft = pendingSend.rawReviewSelection == nil
            ? makeQueuedDraft(from: pendingSend)
            : nil
        let threadBusy = isThreadBusy(codex: codex, threadID: threadID)
        let queuePaused = isQueuePaused(codex: codex, threadID: threadID)
        // Busy-state refresh may wait on the runtime. Publish the queued bubble
        // before any await so follow-ups appear above the first assistant block.
        let queuedDraft = threadBusy
            ? initialQueuedDraft.map { preAppendQueuedDraftMessageIfNeeded($0, codex: codex, threadID: threadID) }
            : initialQueuedDraft

        isSending = true
        isPlanModeArmed = false
        shouldAnchorToAssistantResponse = true
        clearComposer()

        Task { @MainActor in
            defer { isSending = false }

            let stillBusy = await refreshBusyStateIfNeeded(codex: codex, threadID: threadID, wasBusy: threadBusy)
            if stillBusy {
                await performBusyThreadSend(
                    pendingSend,
                    queuedDraft: queuedDraft,
                    codex: codex,
                    threadID: threadID
                )
                return
            }

            let preAppendedMessage = queuedDraft?.preAppendedMessageID.map {
                CodexPreAppendedTurnMessage(messageID: $0, automaticTitleSeed: nil)
            }
            if queuePaused, let queuedDraft {
                appendQueuedDraft(queuedDraft, codex: codex, threadID: threadID)
                clearLocalDraft(codex: codex, threadID: threadID, persistToDisk: true)

                resumeQueueAndFlushIfPossible(codex: codex, threadID: threadID)
                return
            }

            await performTurnSend(
                pendingSend,
                codex: codex,
                threadID: threadID,
                preAppendedMessage: preAppendedMessage
            )
        }
    }

    // Starts a real thread only when the first draft message is sent from the New Chat screen.
    @discardableResult
    func sendNewThread(
        codex: CodexService,
        draftThreadID: String,
        preferredProjectPath: String?,
        onThreadCreated: @escaping @MainActor @Sendable (CodexThread) -> Void,
        onSendFailed: (@MainActor @Sendable () -> Void)? = nil
    ) -> Bool {
        guard let pendingSend = buildValidatedPendingSend(codex: codex) else {
            return false
        }

        isSending = true
        isPlanModeArmed = false
        shouldAnchorToAssistantResponse = true
        let draftPreAppendedMessage = preAppendNewThreadUserMessageIfNeeded(
            pendingSend,
            codex: codex,
            threadID: draftThreadID
        )
        clearComposer()

        Task { @MainActor in
            defer { isSending = false }

            do {
                let thread = try await codex.startThreadIfReady(preferredProjectPath: preferredProjectPath)
                let preAppendedMessage = movePreAppendedNewThreadUserMessageIfNeeded(
                    draftPreAppendedMessage,
                    pendingSend: pendingSend,
                    codex: codex,
                    draftThreadID: draftThreadID,
                    threadID: thread.id
                )
                onThreadCreated(thread)

                do {
                    try await dispatchPendingSend(
                        pendingSend,
                        codex: codex,
                        threadID: thread.id,
                        preAppendedMessage: preAppendedMessage
                    )
                    clearLocalDraft(codex: codex, threadID: draftThreadID, persistToDisk: true)
                    clearLocalDraft(codex: codex, threadID: thread.id, persistToDisk: true)
                } catch {
                    // The real thread is already visible; startTurn owns the failed row/footer state.
                    codex.lastErrorMessage = codex.userFacingTurnErrorMessageForFooter(from: error)
                }
            } catch {
                discardPreAppendedNewThreadUserMessage(
                    draftPreAppendedMessage,
                    codex: codex,
                    draftThreadID: draftThreadID
                )
                restorePendingSendOnFailure(
                    pendingSend,
                    error: error,
                    codex: codex,
                    draftThreadID: draftThreadID
                )
                onSendFailed?()
            }
        }
        return true
    }

    // Shared validation + payload assembly used by `sendTurn` and `sendNewThread`
    // so the empty/connected/blocking/review guards stay in one place.
    private func buildValidatedPendingSend(codex: CodexService) -> PendingTurnSend? {
        let payload = buildPayloadWithMentions()
        let attachments = readyComposerAttachments
        let skillMentions = composerMentionedSkills.map {
            CodexTurnSkillMention(id: $0.name, name: $0.name, path: $0.path)
        }
        let mentionMentions = composerMentionedPlugins.map {
            CodexTurnMention(name: $0.name, path: $0.path)
        }
        let reviewSelection = composerReviewSelection

        guard (!payload.isEmpty || !attachments.isEmpty || reviewSelection != nil || !skillMentions.isEmpty || !mentionMentions.isEmpty),
              !isSending,
              codex.isConnected,
              !hasBlockingAttachmentState else {
            return nil
        }

        if reviewSelection != nil, hasComposerContentConflictingWithReview {
            codex.lastErrorMessage = "Clear text, files, skills, and images before starting a code review."
            return nil
        }

        return PendingTurnSend(
            payload: payload,
            attachments: attachments,
            skillMentions: skillMentions,
            mentionMentions: mentionMentions,
            collaborationMode: isPlanModeArmed ? .plan : nil,
            rawInput: input,
            rawFileMentions: composerMentionedFiles,
            rawSkillMentions: composerMentionedSkills,
            rawPluginMentions: composerMentionedPlugins,
            rawAttachments: composerAttachments,
            rawReviewSelection: reviewSelection,
            rawSubagentsSelectionArmed: isSubagentsSelectionArmed
        )
    }

    // Mirrors a validated PendingTurnSend into the queued-draft shape used when
    // sendTurn needs to defer the payload behind a busy thread or paused queue.
    private func makeQueuedDraft(from pendingSend: PendingTurnSend) -> QueuedTurnDraft {
        QueuedTurnDraft(
            id: UUID().uuidString,
            text: pendingSend.payload,
            attachments: pendingSend.attachments,
            skillMentions: pendingSend.skillMentions,
            mentionMentions: pendingSend.mentionMentions,
            collaborationMode: pendingSend.collaborationMode,
            rawInput: pendingSend.rawInput,
            rawFileMentions: pendingSend.rawFileMentions,
            rawSkillMentions: pendingSend.rawSkillMentions,
            rawPluginMentions: pendingSend.rawPluginMentions,
            rawAttachments: pendingSend.rawAttachments,
            rawSubagentsSelectionArmed: pendingSend.rawSubagentsSelectionArmed,
            createdAt: Date()
        )
    }

    // Moves the immediate draft bubble onto the real thread; falls back to appending
    // there if the draft row was pruned before thread/start returned.
    private func movePreAppendedNewThreadUserMessageIfNeeded(
        _ draftPreAppendedMessage: CodexPreAppendedTurnMessage?,
        pendingSend: PendingTurnSend,
        codex: CodexService,
        draftThreadID: String,
        threadID: String
    ) -> CodexPreAppendedTurnMessage? {
        if let movedMessage = codex.movePreAppendedOutgoingUserMessage(
            draftPreAppendedMessage,
            from: draftThreadID,
            to: threadID
        ) {
            return movedMessage
        }

        return preAppendNewThreadUserMessageIfNeeded(
            pendingSend,
            codex: codex,
            threadID: threadID
        )
    }

    // Cleans up the draft-only optimistic row if thread/start itself fails.
    private func discardPreAppendedNewThreadUserMessage(
        _ draftPreAppendedMessage: CodexPreAppendedTurnMessage?,
        codex: CodexService,
        draftThreadID: String
    ) {
        guard let draftPreAppendedMessage else { return }
        codex.removeUserMessage(
            threadId: draftThreadID,
            messageId: draftPreAppendedMessage.messageID
        )
    }

    // Pre-publishes the first New Chat user row before ContentView swaps in TurnView.
    // Reviews use their own runtime event stream, so only normal turns get a row here.
    private func preAppendNewThreadUserMessageIfNeeded(
        _ pendingSend: PendingTurnSend,
        codex: CodexService,
        threadID: String
    ) -> CodexPreAppendedTurnMessage? {
        guard pendingSend.rawReviewSelection == nil else {
            return nil
        }

        return codex.preAppendOutgoingUserMessage(
            userInput: pendingSend.payload,
            threadId: threadID,
            attachments: pendingSend.attachments,
            skillMentions: pendingSend.skillMentions,
            mentionMentions: pendingSend.mentionMentions,
            fileMentions: confirmedFileMentionPaths(from: pendingSend.rawFileMentions)
        )
    }

    // Routes a PendingTurnSend through the right runtime call (review vs turn)
    // so sendNewThread doesn't have to duplicate the review branch from
    // performTurnSend. Errors bubble to the caller for context-specific recovery.
    private func dispatchPendingSend(
        _ pendingSend: PendingTurnSend,
        codex: CodexService,
        threadID: String,
        preAppendedMessage: CodexPreAppendedTurnMessage? = nil
    ) async throws {
        if let reviewSelection = pendingSend.rawReviewSelection {
            try await codex.startReview(
                threadId: threadID,
                target: reviewSelection.target?.codexReviewTarget,
                baseBranch: reviewBaseBranchName(for: reviewSelection)
            )
        } else {
            try await codex.startTurn(
                userInput: pendingSend.payload,
                threadId: threadID,
                attachments: pendingSend.attachments,
                skillMentions: pendingSend.skillMentions,
                mentionMentions: pendingSend.mentionMentions,
                fileMentions: confirmedFileMentionPaths(from: pendingSend.rawFileMentions),
                shouldAppendUserMessage: preAppendedMessage == nil,
                preAppendedUserMessageID: preAppendedMessage?.messageID,
                automaticTitleSeedOverride: preAppendedMessage?.automaticTitleSeed,
                collaborationMode: pendingSend.collaborationMode
            )
        }
    }

    // Shared failure recovery for both performTurnSend and sendNewThread: restores
    // the exact composer payload so the user can retry without re-typing, persists
    // it under the right thread id, and rebuilds the footer error message.
    private func restorePendingSendOnFailure(
        _ pendingSend: PendingTurnSend,
        error: Error,
        codex: CodexService,
        draftThreadID: String
    ) {
        shouldAnchorToAssistantResponse = false
        restoreComposerState(from: pendingSend)
        saveLocalDraft(codex: codex, threadID: draftThreadID, persistToDisk: true)
        if pendingSend.collaborationMode == .plan,
           shouldRearmPlanModeAfterSendFailure(error) {
            isPlanModeArmed = true
        }
        let fallbackMessage = codex.userFacingTurnErrorMessage(from: error)
        if (codex.lastErrorMessage?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
            && !fallbackMessage.isEmpty {
            codex.lastErrorMessage = fallbackMessage
        }
    }

    func flushQueueIfPossible(codex: CodexService, threadID: String) {
        guard !queuedDrafts(codex: codex, threadID: threadID).isEmpty,
              !isSending,
              steeringDraftID == nil,
              codex.isConnected,
              !isQueuePaused(codex: codex, threadID: threadID),
              !isThreadBusy(codex: codex, threadID: threadID) else {
            return
        }

        guard let nextDraft = dequeueQueuedDraft(codex: codex, threadID: threadID) else {
            return
        }
        isSending = true
        shouldAnchorToAssistantResponse = true

        Task { @MainActor in
            defer { isSending = false }

            do {
                try await codex.startTurn(
                    userInput: nextDraft.text,
                    threadId: threadID,
                    attachments: nextDraft.attachments,
                    skillMentions: nextDraft.skillMentions,
                    mentionMentions: nextDraft.mentionMentions,
                    fileMentions: confirmedFileMentionPaths(from: nextDraft.rawFileMentions),
                    shouldAppendUserMessage: nextDraft.preAppendedMessageID == nil,
                    preAppendedUserMessageID: nextDraft.preAppendedMessageID,
                    collaborationMode: nextDraft.collaborationMode
                )
            } catch {
                shouldAnchorToAssistantResponse = false
                prependQueuedDraft(nextDraft, codex: codex, threadID: threadID)
                let queueErrorMessage = codex.userFacingTurnErrorMessage(from: error)
                setQueuePauseState(.paused(errorMessage: queueErrorMessage), codex: codex, threadID: threadID)
                codex.lastErrorMessage = "Queue paused: \(queueErrorMessage)"
            }
        }
    }

    private func shouldRearmPlanModeAfterSendFailure(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError else {
            return false
        }

        guard case .invalidResponse(let reason) = serviceError else {
            return false
        }

        return reason.localizedCaseInsensitiveContains("plan mode requires an available model")
    }

    // Sends one queued draft into the active turn without disturbing the rest of the queue.
    func steerQueuedDraft(id: String, codex: CodexService, threadID: String) {
        guard codex.isConnected,
              steeringDraftID == nil,
              isThreadBusy(codex: codex, threadID: threadID),
              let draft = queuedDrafts(codex: codex, threadID: threadID).first(where: { $0.id == id }) else {
            return
        }

        steeringDraftID = id
        shouldAnchorToAssistantResponse = true

        Task { @MainActor in
            defer { steeringDraftID = nil }

            do {
                let stillBusy = await refreshBusyStateIfNeeded(codex: codex, threadID: threadID, wasBusy: true)
                if !stillBusy {
                    try await codex.startTurn(
                        userInput: draft.text,
                        threadId: threadID,
                        attachments: draft.attachments,
                        skillMentions: draft.skillMentions,
                        mentionMentions: draft.mentionMentions,
                        fileMentions: confirmedFileMentionPaths(from: draft.rawFileMentions),
                        shouldAppendUserMessage: draft.preAppendedMessageID == nil,
                        preAppendedUserMessageID: draft.preAppendedMessageID,
                        collaborationMode: draft.collaborationMode
                    )
                    removeQueuedDraft(id: id, codex: codex, threadID: threadID, removeOptimisticMessage: false)
                    return
                }

                let expectedTurnID = try await resolveSteerExpectedTurnID(
                    codex: codex,
                    threadID: threadID
                )
                try await codex.steerTurn(
                    userInput: draft.text,
                    threadId: threadID,
                    expectedTurnId: expectedTurnID,
                    attachments: draft.attachments,
                    skillMentions: draft.skillMentions,
                    mentionMentions: draft.mentionMentions,
                    fileMentions: confirmedFileMentionPaths(from: draft.rawFileMentions),
                    shouldAppendUserMessage: draft.preAppendedMessageID == nil,
                    preAppendedUserMessageID: draft.preAppendedMessageID,
                    collaborationMode: draft.collaborationMode
                )
                removeQueuedDraft(id: id, codex: codex, threadID: threadID, removeOptimisticMessage: false)
            } catch {
                shouldAnchorToAssistantResponse = false
                clearQueuedDraftOptimisticMessage(id: id, draft: draft, codex: codex, threadID: threadID)
                codex.lastErrorMessage = codex.userFacingTurnErrorMessage(from: error)
            }
        }
    }

    func resumeQueueAndFlushIfPossible(codex: CodexService, threadID: String) {
        setQueuePauseState(.active, codex: codex, threadID: threadID)
        flushQueueIfPossible(codex: codex, threadID: threadID)
    }

    func interruptTurn(_ turnID: String?, codex: CodexService, threadID: String) {
        Task { @MainActor in
            do {
                try await codex.interruptTurn(turnId: turnID, threadId: threadID)
            } catch {
                // Error message already stored in CodexService.
            }
        }
    }

    func dismissStructuredPlanPrompt(_ message: CodexMessage, codex: CodexService, threadID: String) {
        guard let request = message.structuredUserInputRequest else {
            return
        }

        let requestKey = codex.idKey(from: request.requestID)
        guard !dismissedStructuredPlanPromptRequestKeys.contains(requestKey) else {
            return
        }
        guard dismissingStructuredPlanPromptRequestKeys.insert(requestKey).inserted else {
            return
        }

        isPlanModeArmed = false
        clearComposerAutocomplete()

        Task { @MainActor in
            defer {
                dismissingStructuredPlanPromptRequestKeys.remove(requestKey)
            }

            do {
                try await codex.cancelStructuredPlanSession(
                    requestID: request.requestID,
                    turnId: message.turnId,
                    threadId: threadID
                )
                dismissedStructuredPlanPromptRequestKeys.insert(requestKey)
            } catch {
                codex.lastErrorMessage = codex.userFacingTurnErrorMessage(from: error)
            }
        }
    }

    func isStructuredPlanPromptDismissed(_ requestID: JSONValue, codex: CodexService) -> Bool {
        dismissedStructuredPlanPromptRequestKeys.contains(codex.idKey(from: requestID))
    }

    func isStructuredPlanPromptDismissing(_ requestID: JSONValue, codex: CodexService) -> Bool {
        dismissingStructuredPlanPromptRequestKeys.contains(codex.idKey(from: requestID))
    }

    func reconcileDismissedStructuredPlanPrompts(messages: [CodexMessage], codex: CodexService) {
        let activeRequestKeys: Set<String> = Set(messages.compactMap { message in
            guard message.kind == .userInputPrompt,
                  let request = message.structuredUserInputRequest else {
                return nil
            }
            return codex.idKey(from: request.requestID)
        })

        dismissedStructuredPlanPromptRequestKeys = dismissedStructuredPlanPromptRequestKeys.intersection(activeRequestKeys)
        dismissingStructuredPlanPromptRequestKeys = dismissingStructuredPlanPromptRequestKeys.intersection(activeRequestKeys)
    }

    func approve(
        _ request: CodexApprovalRequest,
        codex: CodexService,
        completion: @escaping @MainActor (Bool) -> Void
    ) {
        Task { @MainActor in
            isHandlingApproval = true
            defer { isHandlingApproval = false }

            do {
                try await codex.approvePendingRequest(request)
                completion(true)
            } catch {
                // Error message already stored in CodexService.
                if let serviceError = error as? CodexServiceError,
                   case .noPendingApproval = serviceError {
                    completion(true)
                } else {
                    completion(false)
                }
            }
        }
    }

    func decline(
        _ request: CodexApprovalRequest,
        codex: CodexService,
        completion: @escaping @MainActor (Bool) -> Void
    ) {
        Task { @MainActor in
            isHandlingApproval = true
            defer { isHandlingApproval = false }

            do {
                try await codex.declinePendingRequest(request)
                completion(true)
            } catch {
                // Error message already stored in CodexService.
                if let serviceError = error as? CodexServiceError,
                   case .noPendingApproval = serviceError {
                    completion(true)
                } else {
                    completion(false)
                }
            }
        }
    }

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

    private static func isMethodNotFoundRPCError(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        return message.contains("method not found")
            || message.contains("unsupported")
            || message.contains("code -32601")
    }

    // Filters pre-indexed skills while ranking name matches above description-only matches.
    private func filteredSkillAutocompleteItems(
        for query: String,
        indexedSkills: [TurnSkillSearchIndexEntry]
    ) -> [CodexSkillMetadata] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else {
            return Array(indexedSkills.lazy.map(\.skill).prefix(maxSkillAutocompleteItems))
        }

        let filtered = indexedSkills.enumerated().compactMap { offset, entry -> (Int, Int, CodexSkillMetadata)? in
            guard let score = entry.matchScore(for: needle) else {
                return nil
            }
            return (score, offset, entry.skill)
        }
            .sorted { lhs, rhs in
                if lhs.0 != rhs.0 {
                    return lhs.0 < rhs.0
                }
                return lhs.1 < rhs.1
            }
            .map { $0.2 }
        return Array(filtered.prefix(maxSkillAutocompleteItems))
    }

    private func shouldRefreshSkillAutocompleteMiss(
        query: String,
        cachedItems: [CodexSkillMetadata],
        cacheKey: String
    ) -> Bool {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedQuery.isEmpty,
              cachedItems.isEmpty,
              !unsupportedSkillsAutocompleteRoots.contains(cacheKey),
              !forceRefreshedSkillMissKeys.contains(skillAutocompleteMissRefreshKey(query: trimmedQuery, cacheKey: cacheKey)) else {
            return false
        }

        return true
    }

    private func rememberSkillAutocompleteMissRefresh(
        query: String,
        cacheKey: String,
        indexedSkills: [TurnSkillSearchIndexEntry]
    ) {
        let refreshedItems = filteredSkillAutocompleteItems(for: query, indexedSkills: indexedSkills)
        let refreshKey = skillAutocompleteMissRefreshKey(query: query, cacheKey: cacheKey)
        if refreshedItems.isEmpty {
            forceRefreshedSkillMissKeys.insert(refreshKey)
        } else {
            forceRefreshedSkillMissKeys.remove(refreshKey)
        }
    }

    private func clearSkillAutocompleteMissRefreshes(cacheKey: String) {
        let prefix = "\(cacheKey)\u{0}"
        forceRefreshedSkillMissKeys = Set(forceRefreshedSkillMissKeys.filter { !$0.hasPrefix(prefix) })
    }

    private func skillAutocompleteMissRefreshKey(query: String, cacheKey: String) -> String {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return "\(cacheKey)\u{0}\(normalizedQuery)"
    }

    private func filteredPluginAutocompleteItems(
        for query: String,
        indexedPlugins: [TurnPluginSearchIndexEntry]
    ) -> [CodexPluginMetadata] {
        let needle = CodexPluginMetadata.normalizedDiscoveryText(query)
        let filtered = indexedPlugins.lazy
            .filter { needle.isEmpty || $0.searchBlob.contains(needle) }
            .map(\.plugin)
        return Array(filtered.prefix(maxPluginAutocompleteItems))
    }

    private func normalizedAutocompleteRoot(for thread: CodexThread) -> String? {
        thread.gitWorkingDirectory
    }

    private func autocompleteCacheKey(forRoot root: String?) -> String {
        root ?? "__global__"
    }

    private func fileAutocompleteCancellationToken(for threadID: String) -> String {
        "ios-at-file-\(threadID)"
    }

    // Reuses the stop-button refresh path so queued sends do not trust stale running flags.
    private func refreshBusyStateIfNeeded(
        codex: CodexService,
        threadID: String,
        wasBusy: Bool
    ) async -> Bool {
        guard wasBusy,
              codex.activeTurnID(for: threadID) == nil,
              (codex.runningThreadIDs.contains(threadID)
                || codex.protectedRunningFallbackThreadIDs.contains(threadID)) else {
            return wasBusy
        }

        _ = await codex.refreshInFlightTurnState(threadId: threadID)
        return isThreadBusy(codex: codex, threadID: threadID)
    }

    private func isThreadBusy(codex: CodexService, threadID: String) -> Bool {
        codex.threadHasActiveOrRunningTurn(threadID)
    }

    // Queues normal follow-ups while a run is active; explicit steer stays behind the queued-draft action.
    private func performBusyThreadSend(
        _ pendingSend: PendingTurnSend,
        queuedDraft: QueuedTurnDraft?,
        codex: CodexService,
        threadID: String
    ) async {
        if pendingSend.rawReviewSelection != nil {
            restoreComposerState(from: pendingSend)
            shouldAnchorToAssistantResponse = false
            codex.lastErrorMessage = "Wait for the current run to finish before starting a code review."
            return
        }

        guard let queuedDraft else {
            restoreComposerState(from: pendingSend)
            shouldAnchorToAssistantResponse = false
            return
        }

        isPlanModeArmed = false
        shouldAnchorToAssistantResponse = true
        appendQueuedDraft(
            preAppendQueuedDraftMessageIfNeeded(queuedDraft, codex: codex, threadID: threadID),
            codex: codex,
            threadID: threadID
        )
        clearLocalDraft(codex: codex, threadID: threadID, persistToDisk: true)
    }

    // Sends the already-cleared composer payload and restores exact raw state if startTurn fails.
    private func performTurnSend(
        _ pendingSend: PendingTurnSend,
        codex: CodexService,
        threadID: String,
        preAppendedMessage: CodexPreAppendedTurnMessage? = nil
    ) async {
        do {
            try await dispatchPendingSend(
                pendingSend,
                codex: codex,
                threadID: threadID,
                preAppendedMessage: preAppendedMessage
            )
            clearLocalDraft(codex: codex, threadID: threadID, persistToDisk: true)
        } catch {
            restorePendingSendOnFailure(
                pendingSend,
                error: error,
                codex: codex,
                draftThreadID: threadID
            )
        }
    }

    // Restores the exact draft state after a failed send so slash/file/skill context survives retries.
    private func restoreComposerState(from pendingSend: PendingTurnSend) {
        input = pendingSend.rawInput
        composerMentionedFiles = pendingSend.rawFileMentions
        composerMentionedSkills = pendingSend.rawSkillMentions
        composerMentionedPlugins = pendingSend.rawPluginMentions
        composerAttachments = pendingSend.rawAttachments
        composerReviewSelection = pendingSend.rawReviewSelection
        isSubagentsSelectionArmed = pendingSend.rawSubagentsSelectionArmed
        isPlanModeArmed = pendingSend.collaborationMode == .plan
    }

    // Carries only autocomplete-confirmed file selections into the timeline renderer.
    private func confirmedFileMentionPaths(from mentions: [TurnComposerMentionedFile]) -> [String] {
        var uniquePaths: [String] = []
        var seenPaths: Set<String> = []

        for mention in mentions {
            let path = mention.path.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !path.isEmpty, seenPaths.insert(path).inserted else {
                continue
            }
            uniquePaths.append(path)
        }

        return uniquePaths
    }

    // Restores a queued row using the exact composer payload captured before it entered the queue.
    private func restoreComposerState(from draft: QueuedTurnDraft) {
        input = draft.rawInput
        composerMentionedFiles = draft.rawFileMentions
        composerMentionedSkills = draft.rawSkillMentions
        composerMentionedPlugins = draft.rawPluginMentions
        composerAttachments = draft.rawAttachments
        composerReviewSelection = nil
        isSubagentsSelectionArmed = draft.rawSubagentsSelectionArmed
        isPlanModeArmed = draft.collaborationMode == .plan
    }

    func restoreComposerState(from draft: TurnComposerLocalDraft) {
        input = draft.input
        composerMentionedFiles = draft.mentionedFiles
        composerMentionedSkills = draft.mentionedSkills
        composerMentionedPlugins = draft.mentionedPlugins
        composerAttachments = draft.attachments
        composerReviewSelection = draft.reviewSelection
        isSubagentsSelectionArmed = draft.isSubagentsSelectionArmed
        isPlanModeArmed = draft.isPlanModeArmed
        clearComposerAutocomplete()
    }

    // Resolves the active turn id for manual steer without relying on async autoclosure operators.
    private func resolveSteerExpectedTurnID(
        codex: CodexService,
        threadID: String
    ) async throws -> String? {
        if let activeTurnID = codex.activeTurnID(for: threadID) {
            return activeTurnID
        }

        return try await codex.resolveInFlightTurnID(threadId: threadID)
    }

    private func queuedDrafts(codex: CodexService, threadID: String) -> [QueuedTurnDraft] {
        codex.queuedTurnDraftsByThread[threadID] ?? []
    }

    private func setQueuedDrafts(_ drafts: [QueuedTurnDraft], codex: CodexService, threadID: String) {
        if drafts.isEmpty {
            codex.queuedTurnDraftsByThread.removeValue(forKey: threadID)
            return
        }
        codex.queuedTurnDraftsByThread[threadID] = drafts
    }

    private func appendQueuedDraft(_ draft: QueuedTurnDraft, codex: CodexService, threadID: String) {
        var drafts = queuedDrafts(codex: codex, threadID: threadID)
        drafts.append(draft)
        setQueuedDrafts(drafts, codex: codex, threadID: threadID)
    }

    // Shows queued follow-ups in the transcript immediately, then reuses the same row
    // when the queue flushes so the bubble does not duplicate at assistant completion.
    private func preAppendQueuedDraftMessageIfNeeded(
        _ draft: QueuedTurnDraft,
        codex: CodexService,
        threadID: String
    ) -> QueuedTurnDraft {
        guard draft.preAppendedMessageID == nil else {
            return draft
        }

        let messageID = codex.appendUserMessage(
            threadId: threadID,
            text: draft.text,
            attachments: draft.attachments,
            fileMentions: confirmedFileMentionPaths(from: draft.rawFileMentions),
            skillMentions: draft.skillMentions.compactMap {
                let rawName = $0.name ?? $0.id
                let normalized = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
                return normalized.isEmpty ? nil : normalized
            },
            pluginMentions: draft.mentionMentions.compactMap {
                let normalized = $0.name.trimmingCharacters(in: .whitespacesAndNewlines)
                return normalized.isEmpty ? nil : normalized
            }
        )

        return messageID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? draft
            : draft.withPreAppendedMessageID(messageID)
    }

    private func removeQueuedDraftOptimisticMessageIfNeeded(
        _ draft: QueuedTurnDraft?,
        codex: CodexService,
        threadID: String
    ) {
        guard let messageID = draft?.preAppendedMessageID else {
            return
        }
        _ = codex.removeUserMessage(threadId: threadID, messageId: messageID)
    }

    private func clearQueuedDraftOptimisticMessage(
        id: String,
        draft: QueuedTurnDraft,
        codex: CodexService,
        threadID: String
    ) {
        if let messageID = draft.preAppendedMessageID {
            _ = codex.removeUserMessage(threadId: threadID, messageId: messageID)
            replaceQueuedDraft(id: id, with: draft.withPreAppendedMessageID(nil), codex: codex, threadID: threadID)
            return
        }

        codex.removeLatestFailedUserMessage(
            threadId: threadID,
            matchingText: draft.text,
            matchingAttachments: draft.attachments
        )
    }

    private func prependQueuedDraft(_ draft: QueuedTurnDraft, codex: CodexService, threadID: String) {
        var drafts = queuedDrafts(codex: codex, threadID: threadID)
        drafts.insert(draft, at: 0)
        setQueuedDrafts(drafts, codex: codex, threadID: threadID)
    }

    private func replaceQueuedDraft(
        id: String,
        with replacement: QueuedTurnDraft,
        codex: CodexService,
        threadID: String
    ) {
        var drafts = queuedDrafts(codex: codex, threadID: threadID)
        guard let index = drafts.firstIndex(where: { $0.id == id }) else {
            return
        }
        drafts[index] = replacement
        setQueuedDrafts(drafts, codex: codex, threadID: threadID)
    }

    private func dequeueQueuedDraft(codex: CodexService, threadID: String) -> QueuedTurnDraft? {
        var drafts = queuedDrafts(codex: codex, threadID: threadID)
        guard !drafts.isEmpty else { return nil }
        let nextDraft = drafts.removeFirst()
        setQueuedDrafts(drafts, codex: codex, threadID: threadID)
        return nextDraft
    }

    private func queuePauseState(codex: CodexService, threadID: String) -> QueuePauseState {
        codex.queuePauseStateByThread[threadID] ?? .active
    }

    private func setQueuePauseState(_ state: QueuePauseState, codex: CodexService, threadID: String) {
        switch state {
        case .active:
            codex.queuePauseStateByThread.removeValue(forKey: threadID)
        case .paused:
            codex.queuePauseStateByThread[threadID] = state
        }
    }

    private func resetFileAutocompleteState() {
        fileAutocompleteDebounceTask?.cancel()
        fileAutocompleteDebounceTask = nil
        fileAutocompleteItems = []
        isFileAutocompleteVisible = false
        isFileAutocompleteLoading = false
        fileAutocompleteQuery = ""
    }

    private func resetSkillAutocompleteState() {
        skillAutocompleteDebounceTask?.cancel()
        skillAutocompleteDebounceTask = nil
        skillAutocompleteItems = []
        isSkillAutocompleteVisible = false
        isSkillAutocompleteLoading = false
        skillAutocompleteQuery = ""
        skillAutocompleteTrigger = "$"
    }

    private func resetPluginAutocompleteState() {
        pluginAutocompleteDebounceTask?.cancel()
        pluginAutocompleteDebounceTask = nil
        pluginAutocompleteItems = []
        isPluginAutocompleteVisible = false
        isPluginAutocompleteLoading = false
        pluginAutocompleteQuery = ""
    }

    private func resetSlashCommandState(
        clearPendingSelection: Bool = false,
        clearConfirmedSelection: Bool = false
    ) {
        slashCommandPanelState = .hidden
        if clearConfirmedSelection {
            composerReviewSelection = nil
            return
        }
        if clearPendingSelection, composerReviewSelection?.target == nil {
            composerReviewSelection = nil
        }
    }

    // Normalizes the composer when a slash action is accepted so the helper token does not leak into the draft.
    private func removeTrailingSlashCommandTokenFromInputIfNeeded() {
        if let updatedInput = Self.removingTrailingSlashCommandToken(in: input) {
            input = updatedInput
        }
    }

    // Arms the inline review flow while keeping its state transitions in one place.
    private func armCodeReviewSelection(
        command: TurnComposerSlashCommand,
        target: TurnComposerReviewTarget?
    ) {
        guard !hasComposerContentConflictingWithReview else {
            resetSlashCommandState(clearPendingSelection: true)
            return
        }

        composerReviewSelection = TurnComposerReviewSelection(command: command, target: target)
        slashCommandPanelState = (target == nil) ? .codeReviewTargets : .hidden
    }

    // Arms the composer-level subagents chip without leaking a slash token into the draft.
    private func armSubagentsSelection() {
        removeTrailingSlashCommandTokenFromInputIfNeeded()
        clearComposerReviewSelectionIfNeededForNonReviewContent()
        isSubagentsSelectionArmed = true
        resetSlashCommandState(clearPendingSelection: true)
    }

    private func clearComposerReviewSelectionIfNeededForInput(_ text: String) {
        guard composerReviewSelection?.target != nil else {
            return
        }

        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            clearComposerReviewSelection()
        }
    }

    func clearComposerReviewSelectionIfNeededForNonReviewContent() {
        guard composerReviewSelection?.target != nil else {
            return
        }

        clearComposerReviewSelection()
    }

    private static func turnComposerReviewTarget(
        for target: CodexPendingCodeReviewTarget
    ) -> TurnComposerReviewTarget {
        switch target {
        case .uncommittedChanges:
            return .uncommittedChanges
        case .baseBranch:
            return .baseBranch
        }
    }

    // Prefixes the composer draft with the canned delegation prompt when the chip is armed.
    static func applyingSubagentsSelection(to text: String, isSelected: Bool) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isSelected,
              let cannedPrompt = TurnComposerSlashCommand.subagents.cannedPrompt else {
            return trimmed
        }

        guard !trimmed.isEmpty else {
            return cannedPrompt
        }

        return "\(cannedPrompt)\n\n\(trimmed)"
    }

    // Replaces inline `@filename` with `@fullpath` for each mentioned file.
    private func buildPayloadWithMentions() -> String {
        var text = input

        if !composerMentionedFiles.isEmpty {
            let ambiguousKeys = Self.ambiguousFileNameAliasKeys(in: composerMentionedFiles)

            for mention in composerMentionedFiles {
                let collisionKey = Self.fileNameAliasCollisionKey(for: mention.fileName)
                let allowFileNameAliases = collisionKey.map { !ambiguousKeys.contains($0) } ?? true
                text = Self.replacingFileMentionAliases(
                    in: text,
                    with: mention,
                    allowFileNameAliases: allowFileNameAliases
                )
            }
        }

        return Self.applyingSubagentsSelection(
            to: text,
            isSelected: isSubagentsSelectionArmed
        )
    }

    // Reuses the git base-branch selector so review requests stay aligned with the visible compare target.
    private func reviewBaseBranchName(for selection: TurnComposerReviewSelection) -> String? {
        guard selection.target == .baseBranch else {
            return nil
        }
        return selectedGitBaseBranch.isEmpty ? localSelectableGitDefaultBranch : selectedGitBaseBranch
    }

    /// Removes the first occurrence of `token` that sits at a word boundary
    /// (followed by whitespace, punctuation, or end-of-string). Consumes one trailing space when present.
    static func removeBoundedToken(
        _ token: String,
        from text: String,
        caseInsensitive: Bool = false
    ) -> String {
        let escaped = NSRegularExpression.escapedPattern(for: token)
        let options: NSRegularExpression.Options = caseInsensitive ? [.caseInsensitive] : []
        guard let regex = try? NSRegularExpression(
            pattern: escaped + "(?:[\\s,.;:!?)\\]}>]|$)",
            options: options
        ) else {
            return text
        }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, range: range) else {
            return text
        }
        var result = text
        let matchRange = Range(match.range, in: text)!
        result.replaceSubrange(matchRange, with: "")
        return result
    }

    /// Replaces all boundary-safe occurrences of `token` with `replacement`.
    /// Boundary = followed by whitespace, punctuation, or end-of-string.
    static func replaceBoundedToken(
        _ token: String,
        with replacement: String,
        in text: String,
        caseInsensitive: Bool = false
    ) -> String {
        let escaped = NSRegularExpression.escapedPattern(for: token)
        let options: NSRegularExpression.Options = caseInsensitive ? [.caseInsensitive] : []
        guard let regex = try? NSRegularExpression(
            pattern: escaped + "(?=[\\s,.;:!?)\\]}>]|$)",
            options: options
        ) else {
            return text
        }
        let range = NSRange(text.startIndex..., in: text)
        let safeReplacement = NSRegularExpression.escapedTemplate(for: replacement)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: safeReplacement)
    }

}

struct TurnComposerMentionedFile: Identifiable, Codable, Equatable, Sendable {
    let id: String
    let fileName: String
    let path: String

    init(id: String = UUID().uuidString, fileName: String, path: String) {
        self.id = id
        self.fileName = fileName
        self.path = path
    }
}

struct TurnComposerMentionedSkill: Identifiable, Codable, Equatable, Sendable {
    let id: String
    let name: String
    let path: String?
    let description: String?

    init(id: String = UUID().uuidString, name: String, path: String?, description: String?) {
        self.id = id
        self.name = name
        self.path = path
        self.description = description
    }
}

struct TurnComposerMentionedPlugin: Identifiable, Codable, Equatable, Sendable {
    let id: String
    let name: String
    let path: String
    let displayName: String?

    init(id: String = UUID().uuidString, name: String, path: String, displayName: String?) {
        self.id = id
        self.name = name
        self.path = path
        self.displayName = displayName
    }
}

private struct TurnSkillSearchIndexEntry: Equatable {
    let skill: CodexSkillMetadata
    let name: String
    let displayName: String
    let description: String

    init(skill: CodexSkillMetadata) {
        self.skill = skill
        self.name = skill.name.lowercased()
        self.displayName = SkillDisplayNameFormatter.displayName(for: skill.name).lowercased()
        self.description = skill.description?.lowercased() ?? ""
    }

    func matchScore(for needle: String) -> Int? {
        if name == needle || displayName == needle {
            return 0
        }
        if name.hasPrefix(needle) || displayName.hasPrefix(needle) {
            return 1
        }
        if name.contains(needle) || displayName.contains(needle) {
            return 2
        }
        if description.hasPrefix(needle) {
            return 3
        }
        if description.contains(needle) {
            return 4
        }
        return nil
    }
}

private struct TurnPluginSearchIndexEntry: Equatable {
    let plugin: CodexPluginMetadata
    let searchBlob: String

    init(plugin: CodexPluginMetadata) {
        self.plugin = plugin
        self.searchBlob = plugin.searchBlob
    }
}
