// FILE: TurnViewModel+LifecycleDrafts.swift
// Purpose: Owns chat-view lifecycle tasks, timeline projection cache, and local composer draft persistence.
// Layer: View Model
// Exports: TurnViewModel lifecycle and local draft helpers
// Depends on: Observation, CodexService, TurnComposerLocalDraft

import Observation

@MainActor
extension TurnViewModel {
    func updateProjectedTimeline(threadID: String, messages: [CodexMessage], changeToken: Int) {
        guard threadID != lastProjectedThreadID || changeToken != lastProjectionChangeToken else { return }
        lastProjectedThreadID = threadID
        lastProjectionChangeToken = changeToken
        projectedMessages = TurnTimelineReducer.project(messages: messages).messages
    }

    func cancelThreadActivation() { threadActivationTask?.cancel() }

    // Cancels view-scoped async work before the chat view model disappears.
    func cancelTransientTasks() {
        threadActivationTask?.cancel()
        threadActivationTask = nil
        fileAutocompleteDebounceTask?.cancel()
        fileAutocompleteDebounceTask = nil
        skillAutocompleteDebounceTask?.cancel()
        skillAutocompleteDebounceTask = nil
        pluginAutocompleteDebounceTask?.cancel()
        pluginAutocompleteDebounceTask = nil
        localDraftPersistenceDebounceTask?.cancel()
        localDraftPersistenceDebounceTask = nil
        gitStatusRefreshTask?.cancel()
        gitStatusRefreshTask = nil
        let loadingAttachmentIDs = composerAttachments.compactMap { attachment -> String? in
            guard attachment.state == .loading else { return nil }
            return attachment.id
        }
        detachedAttachmentLoadIDs.formUnion(attachmentLoadTasks.keys)
        detachedAttachmentLoadIDs.formUnion(loadingAttachmentIDs)
        attachmentLoadTasks.removeAll()
    }

    func activateThread(threadID: String, codex: CodexService, onComplete: @escaping () -> Void) {
        threadActivationTask?.cancel()
        threadActivationTask = Task { @MainActor [weak self] in
            guard !Task.isCancelled else { return }
            let didPrepare = await codex.prepareThreadForDisplay(threadId: threadID)
            guard didPrepare, !Task.isCancelled, codex.activeThreadId == threadID else { return }
            self?.flushQueueIfPossible(codex: codex, threadID: threadID)
            onComplete()
        }
    }

    func localDraftSnapshot() -> TurnComposerLocalDraft {
        TurnComposerLocalDraft.make(
            input: input,
            mentionedFiles: composerMentionedFiles,
            mentionedSkills: composerMentionedSkills,
            mentionedPlugins: composerMentionedPlugins,
            attachments: composerAttachments,
            reviewSelection: composerReviewSelection,
            isPlanModeArmed: isPlanModeArmed,
            isSubagentsSelectionArmed: isSubagentsSelectionArmed
        )
    }

    func saveLocalDraft(
        codex: CodexService,
        threadID: String,
        persistToDisk: Bool = false,
        advancesAttachmentMergeRevision: Bool = true
    ) {
        let draft = localDraftSnapshot()
        if isSending, draft.isEmpty {
            if persistToDisk {
                flushLocalDraftPersistence(codex: codex)
            }
            return
        }

        let shouldAdvanceMergeRevision = advancesAttachmentMergeRevision && !hasLoadingComposerAttachments
        codex.setComposerDraft(
            draft.isEmpty ? nil : draft,
            for: threadID,
            advancesAttachmentMergeRevision: shouldAdvanceMergeRevision
        )
        codex.setComposerDraftPendingAttachmentIDs(loadingComposerAttachmentIDs, for: threadID)
        if persistToDisk {
            flushLocalDraftPersistence(codex: codex)
        } else {
            scheduleLocalDraftPersistence(codex: codex)
        }
    }

    func saveLifecycleLocalDraft(codex: CodexService, threadID: String) {
        saveLocalDraft(
            codex: codex,
            threadID: threadID,
            persistToDisk: true,
            advancesAttachmentMergeRevision: false
        )
    }

    func clearLocalDraft(codex: CodexService, threadID: String, persistToDisk: Bool = false) {
        codex.setComposerDraft(nil, for: threadID)
        if persistToDisk {
            flushLocalDraftPersistence(codex: codex)
        } else {
            scheduleLocalDraftPersistence(codex: codex)
        }
    }

    func restoreSavedLocalDraftIfNeeded(codex: CodexService, threadID: String) {
        reattachVisibleAttachmentLoads()
        guard let draft = codex.composerDraft(for: threadID),
              canRestoreSavedLocalDraft(draft),
              !draft.isEmpty else {
            return
        }

        if hasComposerDraftContent {
            restoreVisibleComposerState(from: draft)
        } else {
            restoreComposerState(from: draft)
        }
    }

    func scheduleLocalDraftPersistence(codex: CodexService) {
        localDraftPersistenceDebounceTask?.cancel()
        localDraftPersistenceDebounceTask = Task { @MainActor [weak self, weak codex] in
            guard let self, let codex else { return }

            do {
                try await Task.sleep(nanoseconds: localDraftPersistenceDebounceNanoseconds)
            } catch {
                return
            }

            guard !Task.isCancelled else { return }
            codex.persistComposerDrafts()
            self.localDraftPersistenceDebounceTask = nil
        }
    }

    func flushLocalDraftPersistence(codex: CodexService) {
        localDraftPersistenceDebounceTask?.cancel()
        localDraftPersistenceDebounceTask = nil
        codex.persistComposerDrafts()
    }

    private var hasLoadingComposerAttachments: Bool {
        composerAttachments.contains { $0.state == .loading }
    }

    private var loadingComposerAttachmentIDs: Set<String> {
        Set(composerAttachments.compactMap { attachment -> String? in
            attachment.state == .loading ? attachment.id : nil
        })
    }

    private func restoreVisibleComposerState(from draft: TurnComposerLocalDraft) {
        input = draft.input
        composerMentionedFiles = draft.mentionedFiles
        composerMentionedSkills = draft.mentionedSkills
        composerMentionedPlugins = draft.mentionedPlugins

        let draftAttachmentsByID = Dictionary(uniqueKeysWithValues: draft.attachments.map { ($0.id, $0) })
        let liveAttachmentIDs = Set(composerAttachments.map(\.id))
        var restoredAttachments = composerAttachments.map { attachment in
            draftAttachmentsByID[attachment.id] ?? attachment
        }
        restoredAttachments.append(contentsOf: draft.attachments.filter { !liveAttachmentIDs.contains($0.id) })
        composerAttachments = restoredAttachments

        composerReviewSelection = draft.reviewSelection
        isSubagentsSelectionArmed = draft.isSubagentsSelectionArmed
        isPlanModeArmed = draft.isPlanModeArmed
        clearComposerAutocomplete()
    }

    private func reattachVisibleAttachmentLoads() {
        let visibleLoadingAttachmentIDs = Set(composerAttachments.compactMap { attachment -> String? in
            attachment.state == .loading ? attachment.id : nil
        })
        detachedAttachmentLoadIDs.subtract(visibleLoadingAttachmentIDs)
    }

    private func canRestoreSavedLocalDraft(_ draft: TurnComposerLocalDraft) -> Bool {
        if !hasComposerDraftContent {
            return true
        }

        guard input == draft.input,
              composerMentionedFiles == draft.mentionedFiles,
              composerMentionedSkills == draft.mentionedSkills,
              composerMentionedPlugins == draft.mentionedPlugins,
              composerReviewSelection == draft.reviewSelection,
              isPlanModeArmed == draft.isPlanModeArmed,
              isSubagentsSelectionArmed == draft.isSubagentsSelectionArmed else {
            return false
        }

        let readyAttachments = composerAttachments.compactMap { attachment -> TurnComposerImageAttachment? in
            if case .ready = attachment.state {
                return attachment
            }
            return nil
        }
        let loadingAttachmentIDs = Set(composerAttachments.compactMap { attachment -> String? in
            attachment.state == .loading ? attachment.id : nil
        })
        let hasOnlyRestorableAttachmentStates = composerAttachments.allSatisfy { attachment in
            switch attachment.state {
            case .loading, .ready:
                return true
            case .failed:
                return false
            }
        }
        var draftAttachmentsByID: [String: TurnComposerImageAttachment] = [:]
        for attachment in draft.attachments {
            draftAttachmentsByID[attachment.id] = attachment
        }
        let liveAttachmentIDs = Set(composerAttachments.map(\.id))
        let draftAttachmentIDs = Set(draftAttachmentsByID.keys)

        guard hasOnlyRestorableAttachmentStates,
              !loadingAttachmentIDs.isEmpty,
              draftAttachmentIDs.isSubset(of: liveAttachmentIDs),
              !draftAttachmentIDs.isDisjoint(with: loadingAttachmentIDs),
              readyAttachments.allSatisfy({ readyAttachment in
                  draftAttachmentsByID[readyAttachment.id].map { $0 == readyAttachment } ?? true
              }) else {
            return false
        }

        return true
    }
}
