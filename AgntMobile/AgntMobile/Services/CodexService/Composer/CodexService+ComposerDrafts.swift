// FILE: CodexService+ComposerDrafts.swift
// Purpose: Composer draft and one-shot composer action state helpers.
// Layer: Service
// Exports: CodexService composer draft APIs
// Depends on: TurnComposerLocalDraft

import Foundation

extension CodexService {
    // Stores one-shot composer setup so a newly created thread can open in the requested mode.
    func queuePendingComposerAction(_ action: CodexPendingThreadComposerAction, for threadId: String) {
        pendingComposerActionByThreadID[threadId] = action
    }

    // Consumes the pending composer setup once the destination thread view appears.
    func consumePendingComposerAction(for threadId: String) -> CodexPendingThreadComposerAction? {
        pendingComposerActionByThreadID.removeValue(forKey: threadId)
    }

    func composerDraft(for threadId: String) -> TurnComposerLocalDraft? {
        composerDraftsByThreadID[threadId]
    }

    func composerDraftMergeRevision(for threadId: String) -> Int {
        composerDraftMergeRevisionByThreadID[threadId] ?? 0
    }

    func setComposerDraftPendingAttachmentIDs(_ ids: Set<String>, for threadId: String) {
        composerDraftPendingAttachmentIDsByThreadID[threadId] = ids
    }

    func canMergePendingComposerAttachment(id attachmentID: String, for threadId: String) -> Bool {
        guard let pendingAttachmentIDs = composerDraftPendingAttachmentIDsByThreadID[threadId] else {
            return true
        }

        return pendingAttachmentIDs.contains(attachmentID)
    }

    func markPendingComposerAttachmentMerged(id attachmentID: String, for threadId: String) {
        guard var pendingAttachmentIDs = composerDraftPendingAttachmentIDsByThreadID[threadId] else {
            return
        }

        pendingAttachmentIDs.remove(attachmentID)
        setComposerDraftPendingAttachmentIDs(pendingAttachmentIDs, for: threadId)
    }

    func setComposerDraft(
        _ draft: TurnComposerLocalDraft?,
        for threadId: String,
        persistToDisk: Bool = false,
        advancesAttachmentMergeRevision: Bool = true
    ) {
        if let draft, !draft.isEmpty {
            composerDraftsByThreadID[threadId] = draft
        } else {
            composerDraftsByThreadID.removeValue(forKey: threadId)
            composerDraftPendingAttachmentIDsByThreadID.removeValue(forKey: threadId)
        }

        if advancesAttachmentMergeRevision {
            composerDraftMergeRevisionByThreadID[threadId, default: 0] += 1
        }

        if persistToDisk {
            persistComposerDrafts()
        }
    }

    func persistComposerDrafts() {
        guard !suspendAutomaticMacScopedPersistence else {
            return
        }

        composerDraftPersistence.save(
            composerDraftsByThreadID,
            macDeviceId: currentMacScopedPersistenceDeviceId
        )
    }
}
