// FILE: TurnViewModel+ComposerState.swift
// Purpose: Composer state, chips, slash commands, and payload helpers.
// Layer: View Model

import Foundation

extension TurnViewModel {
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

    // Restores the exact draft state after a failed send so slash/file/skill context survives retries.
    func restoreComposerState(from pendingSend: PendingTurnSend) {
        input = pendingSend.rawInput
        composerMentionedFiles = pendingSend.rawFileMentions
        composerMentionedSkills = pendingSend.rawSkillMentions
        composerMentionedPlugins = pendingSend.rawPluginMentions
        composerAttachments = pendingSend.rawAttachments
        composerReviewSelection = pendingSend.rawReviewSelection
        isSubagentsSelectionArmed = pendingSend.rawSubagentsSelectionArmed
        isPlanModeArmed = pendingSend.collaborationMode == .plan
    }

    // Restores a queued row using the exact composer payload captured before it entered the queue.
    func restoreComposerState(from draft: QueuedTurnDraft) {
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
    func resolveSteerExpectedTurnID(
        codex: CodexService,
        threadID: String
    ) async throws -> String? {
        if let activeTurnID = codex.activeTurnID(for: threadID) {
            return activeTurnID
        }

        return try await codex.resolveInFlightTurnID(threadId: threadID)
    }

    func resetFileAutocompleteState() {
        fileAutocompleteDebounceTask?.cancel()
        fileAutocompleteDebounceTask = nil
        fileAutocompleteItems = []
        isFileAutocompleteVisible = false
        isFileAutocompleteLoading = false
        fileAutocompleteQuery = ""
    }

    func resetSkillAutocompleteState() {
        skillAutocompleteDebounceTask?.cancel()
        skillAutocompleteDebounceTask = nil
        skillAutocompleteItems = []
        isSkillAutocompleteVisible = false
        isSkillAutocompleteLoading = false
        skillAutocompleteQuery = ""
        skillAutocompleteTrigger = "$"
    }

    func resetPluginAutocompleteState() {
        pluginAutocompleteDebounceTask?.cancel()
        pluginAutocompleteDebounceTask = nil
        pluginAutocompleteItems = []
        isPluginAutocompleteVisible = false
        isPluginAutocompleteLoading = false
        pluginAutocompleteQuery = ""
    }

    func resetSlashCommandState(
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
    func removeTrailingSlashCommandTokenFromInputIfNeeded() {
        if let updatedInput = Self.removingTrailingSlashCommandToken(in: input) {
            input = updatedInput
        }
    }

    // Arms the inline review flow while keeping its state transitions in one place.
    func armCodeReviewSelection(
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
    func armSubagentsSelection() {
        removeTrailingSlashCommandTokenFromInputIfNeeded()
        clearComposerReviewSelectionIfNeededForNonReviewContent()
        isSubagentsSelectionArmed = true
        resetSlashCommandState(clearPendingSelection: true)
    }

    func clearComposerReviewSelectionIfNeededForInput(_ text: String) {
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

    // Replaces inline `@filename` with `@fullpath` for each mentioned file.
    func buildPayloadWithMentions() -> String {
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
    func reviewBaseBranchName(for selection: TurnComposerReviewSelection) -> String? {
        guard selection.target == .baseBranch else {
            return nil
        }
        return selectedGitBaseBranch.isEmpty ? localSelectableGitDefaultBranch : selectedGitBaseBranch
    }
}
