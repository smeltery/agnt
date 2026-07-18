// FILE: TurnViewModel+Attachments.swift
// Purpose: Handles composer image attachment intake, loading, removal, and draft merges.
// Layer: View Model
// Exports: TurnViewModel attachment helpers
// Depends on: SwiftUI, PhotosUI, CodexService

import SwiftUI
import PhotosUI

@MainActor
extension TurnViewModel {
    var remainingAttachmentSlots: Int {
        max(0, maxComposerImages - composerAttachments.count)
    }

    func removeComposerAttachment(id: String) {
        attachmentLoadTasks[id]?.cancel()
        attachmentLoadTasks[id] = nil
        detachedAttachmentLoadIDs.remove(id)
        composerAttachments.removeAll(where: { $0.id == id })
    }

    func removeComposerAttachment(id: String, codex: CodexService, threadID: String) {
        removeComposerAttachment(id: id)
        saveLocalDraft(codex: codex, threadID: threadID)
    }

    func openCamera(codex: CodexService) {
        guard remainingAttachmentSlots > 0 else {
            codex.lastErrorMessage = "You can attach up to \(maxComposerImages) images per message."
            return
        }
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            codex.lastErrorMessage = "Camera is not available on this device."
            return
        }
        isCameraPresented = true
    }

    func enqueueCapturedImageData(_ data: Data, codex: CodexService, threadID: String) {
        enqueuePastedImageData([data], codex: codex, threadID: threadID)
    }

    func openPhotoLibraryPicker(codex: CodexService) {
        guard remainingAttachmentSlots > 0 else {
            codex.lastErrorMessage = "You can attach up to \(maxComposerImages) images per message."
            return
        }

        isPhotoPickerPresented = true
    }

    // Converts the picker results into loading slots and async image pipeline jobs.
    func enqueuePhotoPickerItems(_ items: [PhotosPickerItem], codex: CodexService, threadID: String) {
        guard !items.isEmpty else {
            return
        }

        let intakePlan = TurnComposerAttachmentIntakePlan.make(
            requestedCount: items.count,
            remainingSlots: remainingAttachmentSlots
        )

        guard intakePlan.acceptedCount > 0 else {
            codex.lastErrorMessage = "You can attach up to \(maxComposerImages) images per message."
            return
        }

        let acceptedItems = Array(items.prefix(intakePlan.acceptedCount))
        if intakePlan.hasOverflow {
            codex.lastErrorMessage = "Only \(maxComposerImages) images are allowed per message."
        }

        clearComposerReviewSelectionIfNeededForNonReviewContent()

        let attachmentJobs = acceptedItems.map { item in
            (id: UUID().uuidString, item: item)
        }
        for job in attachmentJobs {
            composerAttachments.append(TurnComposerImageAttachment(id: job.id, state: .loading))
        }
        saveLocalDraft(codex: codex, threadID: threadID)
        let expectedDraftMergeRevision = codex.composerDraftMergeRevision(for: threadID)
        let expectedDraftMergeEpoch = codex.composerDraftMergeEpoch
        let attachmentOrder = composerAttachments.map(\.id)

        for job in attachmentJobs {
            attachmentLoadTasks[job.id] = Task { @MainActor [weak self] in
                let state = await Self.loadComposerAttachmentState(from: job.item)
                guard !Task.isCancelled else { return }
                Self.completeAttachmentLoad(
                    state,
                    id: job.id,
                    viewModel: self,
                    expectedDraftMergeRevision: expectedDraftMergeRevision,
                    expectedDraftMergeEpoch: expectedDraftMergeEpoch,
                    attachmentOrder: attachmentOrder,
                    codex: codex,
                    threadID: threadID
                )
            }
        }
    }

    // Reuses the picker intake pipeline so pasted images obey the same limits and processing.
    func enqueuePastedImageData(_ imageDataItems: [Data], codex: CodexService, threadID: String) {
        guard !imageDataItems.isEmpty else {
            return
        }

        let intakePlan = TurnComposerAttachmentIntakePlan.make(
            requestedCount: imageDataItems.count,
            remainingSlots: remainingAttachmentSlots
        )

        guard intakePlan.acceptedCount > 0 else {
            codex.lastErrorMessage = "You can attach up to \(maxComposerImages) images per message."
            return
        }

        let acceptedItems = Array(imageDataItems.prefix(intakePlan.acceptedCount))
        if intakePlan.hasOverflow {
            codex.lastErrorMessage = "Only \(maxComposerImages) images are allowed per message."
        }

        clearComposerReviewSelectionIfNeededForNonReviewContent()

        let attachmentJobs = acceptedItems.map { imageData in
            (id: UUID().uuidString, imageData: imageData)
        }
        for job in attachmentJobs {
            composerAttachments.append(TurnComposerImageAttachment(id: job.id, state: .loading))
        }
        saveLocalDraft(codex: codex, threadID: threadID)
        let expectedDraftMergeRevision = codex.composerDraftMergeRevision(for: threadID)
        let expectedDraftMergeEpoch = codex.composerDraftMergeEpoch
        let attachmentOrder = composerAttachments.map(\.id)

        for job in attachmentJobs {
            attachmentLoadTasks[job.id] = Task { @MainActor [weak self] in
                let state = await Self.loadComposerAttachmentState(fromData: job.imageData)
                guard !Task.isCancelled else { return }
                Self.completeAttachmentLoad(
                    state,
                    id: job.id,
                    viewModel: self,
                    expectedDraftMergeRevision: expectedDraftMergeRevision,
                    expectedDraftMergeEpoch: expectedDraftMergeEpoch,
                    attachmentOrder: attachmentOrder,
                    codex: codex,
                    threadID: threadID
                )
            }
        }
    }

    func cancelAttachmentLoadTasks() {
        for task in attachmentLoadTasks.values {
            task.cancel()
        }
        attachmentLoadTasks.removeAll()
    }

    static func completeAttachmentLoad(
        _ state: TurnComposerImageAttachmentState,
        id attachmentID: String,
        viewModel: TurnViewModel?,
        expectedDraftMergeRevision: Int,
        expectedDraftMergeEpoch: Int? = nil,
        attachmentOrder: [String]? = nil,
        codex: CodexService,
        threadID: String
    ) {
        let resolvedExpectedDraftMergeEpoch = expectedDraftMergeEpoch ?? codex.composerDraftMergeEpoch
        let resolvedAttachmentOrder = attachmentOrder ?? [attachmentID]

        guard codex.composerDraftMergeEpoch == resolvedExpectedDraftMergeEpoch else {
            viewModel?.attachmentLoadTasks[attachmentID] = nil
            return
        }

        if let viewModel {
            if viewModel.detachedAttachmentLoadIDs.remove(attachmentID) != nil {
                if state == .failed,
                   viewModel.composerAttachments.contains(where: { $0.id == attachmentID }) {
                    viewModel.updateComposerAttachment(
                        id: attachmentID,
                        state: state,
                        codex: codex,
                        threadID: threadID,
                        advancesAttachmentMergeRevision: false
                    )
                    return
                }
                mergeDecodedAttachmentIntoSavedDraft(
                    state,
                    id: attachmentID,
                    expectedDraftMergeRevision: expectedDraftMergeRevision,
                    expectedDraftMergeEpoch: resolvedExpectedDraftMergeEpoch,
                    attachmentOrder: resolvedAttachmentOrder,
                    codex: codex,
                    threadID: threadID
                )
                return
            }
            defer { viewModel.attachmentLoadTasks[attachmentID] = nil }
            guard viewModel.composerAttachments.contains(where: { $0.id == attachmentID }) else {
                return
            }
            viewModel.updateComposerAttachment(
                id: attachmentID,
                state: state,
                codex: codex,
                threadID: threadID,
                advancesAttachmentMergeRevision: false
            )
            return
        }

        mergeDecodedAttachmentIntoSavedDraft(
            state,
            id: attachmentID,
            expectedDraftMergeRevision: expectedDraftMergeRevision,
            expectedDraftMergeEpoch: resolvedExpectedDraftMergeEpoch,
            attachmentOrder: resolvedAttachmentOrder,
            codex: codex,
            threadID: threadID
        )
    }

    private func updateComposerAttachment(
        id: String,
        state: TurnComposerImageAttachmentState,
        codex: CodexService,
        threadID: String,
        advancesAttachmentMergeRevision: Bool = true
    ) {
        guard let index = composerAttachments.firstIndex(where: { $0.id == id }) else {
            return
        }

        composerAttachments[index].state = state
        saveLocalDraft(
            codex: codex,
            threadID: threadID,
            persistToDisk: true,
            advancesAttachmentMergeRevision: advancesAttachmentMergeRevision
        )
    }

    private static func mergeDecodedAttachmentIntoSavedDraft(
        _ state: TurnComposerImageAttachmentState,
        id attachmentID: String,
        expectedDraftMergeRevision: Int,
        expectedDraftMergeEpoch: Int,
        attachmentOrder: [String],
        codex: CodexService,
        threadID: String
    ) {
        guard case .ready = state else { return }
        guard codex.composerDraftMergeEpoch == expectedDraftMergeEpoch else { return }
        guard codex.composerDraftMergeRevision(for: threadID) == expectedDraftMergeRevision else { return }
        guard codex.canMergePendingComposerAttachment(id: attachmentID, for: threadID) else { return }
        let existing = codex.composerDraft(for: threadID)
        var attachments = existing?.attachments ?? []
        guard !attachments.contains(where: { $0.id == attachmentID }) else {
            codex.markPendingComposerAttachmentMerged(id: attachmentID, for: threadID)
            return
        }
        attachments.append(TurnComposerImageAttachment(id: attachmentID, state: state))
        attachments = orderedDraftAttachments(attachments, attachmentOrder: attachmentOrder)

        let merged = TurnComposerLocalDraft(
            input: existing?.input ?? "",
            mentionedFiles: existing?.mentionedFiles ?? [],
            mentionedSkills: existing?.mentionedSkills ?? [],
            mentionedPlugins: existing?.mentionedPlugins ?? [],
            attachments: attachments,
            reviewSelection: existing?.reviewSelection,
            isPlanModeArmed: existing?.isPlanModeArmed ?? false,
            isSubagentsSelectionArmed: existing?.isSubagentsSelectionArmed ?? false,
            updatedAt: Date()
        )
        codex.setComposerDraft(
            merged,
            for: threadID,
            persistToDisk: true,
            advancesAttachmentMergeRevision: false
        )
        codex.markPendingComposerAttachmentMerged(id: attachmentID, for: threadID)
    }

    private static func orderedDraftAttachments(
        _ attachments: [TurnComposerImageAttachment],
        attachmentOrder: [String]
    ) -> [TurnComposerImageAttachment] {
        guard !attachmentOrder.isEmpty else {
            return attachments
        }

        var orderByID: [String: Int] = [:]
        for (index, id) in attachmentOrder.enumerated() where orderByID[id] == nil {
            orderByID[id] = index
        }

        return attachments.enumerated()
            .sorted { lhs, rhs in
                let lhsOrder = orderByID[lhs.element.id] ?? Int.max
                let rhsOrder = orderByID[rhs.element.id] ?? Int.max
                if lhsOrder != rhsOrder {
                    return lhsOrder < rhsOrder
                }
                return lhs.offset < rhs.offset
            }
            .map(\.element)
    }
}
