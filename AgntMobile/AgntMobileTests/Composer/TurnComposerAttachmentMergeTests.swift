// FILE: TurnComposerAttachmentMergeTests.swift
// Purpose: Verifies late attachment completion and draft merge behavior.
// Layer: Unit Test
// Exports: TurnComposerAttachmentMergeTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class TurnComposerAttachmentMergeTests: TurnComposerSendTestCase {
    func testAttachmentLoadCompletionUpdatesLiveLoadingTile() {
        let service = makeService()
        let viewModel = TurnViewModel()
        let attachment = CodexImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,AAAA"
        )

        viewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "attachment-live", state: .loading)
        ]
        viewModel.saveLocalDraft(codex: service, threadID: "thread-live-attachment")
        let expectedRevision = service.composerDraftMergeRevision(for: "thread-live-attachment")
        service.setComposerDraft(nil, for: "thread-live-attachment")

        TurnViewModel.completeAttachmentLoad(
            .ready(attachment),
            id: "attachment-live",
            viewModel: viewModel,
            expectedDraftMergeRevision: expectedRevision,
            codex: service,
            threadID: "thread-live-attachment"
        )

        XCTAssertEqual(viewModel.readyComposerAttachments, [attachment])
        XCTAssertFalse(viewModel.hasBlockingAttachmentState)
    }

    func testLateAttachmentLoadMergesOnlyWhenDraftRevisionIsUnchanged() {
        let service = makeService()
        let attachment = CodexImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,AAAA"
        )
        let preservingViewModel = TurnViewModel()
        preservingViewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "attachment-preserve", state: .loading)
        ]
        preservingViewModel.saveLocalDraft(codex: service, threadID: "thread-preserve-attachment")
        let preservingRevision = service.composerDraftMergeRevision(for: "thread-preserve-attachment")

        TurnViewModel.completeAttachmentLoad(
            .ready(attachment),
            id: "attachment-preserve",
            viewModel: nil,
            expectedDraftMergeRevision: preservingRevision,
            codex: service,
            threadID: "thread-preserve-attachment"
        )

        XCTAssertEqual(service.composerDraft(for: "thread-preserve-attachment")?.attachments, [
            TurnComposerImageAttachment(id: "attachment-preserve", state: .ready(attachment))
        ])

        let staleViewModel = TurnViewModel()
        staleViewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "attachment-stale", state: .loading)
        ]
        staleViewModel.saveLocalDraft(codex: service, threadID: "thread-stale-attachment")
        let staleRevision = service.composerDraftMergeRevision(for: "thread-stale-attachment")
        service.setComposerDraft(nil, for: "thread-stale-attachment")

        TurnViewModel.completeAttachmentLoad(
            .ready(attachment),
            id: "attachment-stale",
            viewModel: nil,
            expectedDraftMergeRevision: staleRevision,
            codex: service,
            threadID: "thread-stale-attachment"
        )

        XCTAssertNil(service.composerDraft(for: "thread-stale-attachment"))
    }

    func testLateAttachmentLoadDoesNotMergeAfterMacScopedDraftsReset() {
        let service = makeService()
        let attachment = CodexImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,AAAA"
        )
        let viewModel = TurnViewModel()
        let threadID = "thread-mac-scope-attachment"
        viewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "attachment-mac-scope", state: .loading)
        ]
        viewModel.saveLocalDraft(codex: service, threadID: threadID)

        let expectedRevision = service.composerDraftMergeRevision(for: threadID)
        let expectedEpoch = service.composerDraftMergeEpoch
        service.clearInMemoryMacScopedState()

        XCTAssertEqual(service.composerDraftMergeRevision(for: threadID), expectedRevision)
        XCTAssertNotEqual(service.composerDraftMergeEpoch, expectedEpoch)

        TurnViewModel.completeAttachmentLoad(
            .ready(attachment),
            id: "attachment-mac-scope",
            viewModel: nil,
            expectedDraftMergeRevision: expectedRevision,
            expectedDraftMergeEpoch: expectedEpoch,
            attachmentOrder: ["attachment-mac-scope"],
            codex: service,
            threadID: threadID
        )

        XCTAssertNil(service.composerDraft(for: threadID))
    }

    func testLifecycleDraftSaveDoesNotBlockLateAttachmentMerge() {
        let service = makeService()
        let attachment = CodexImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,AAAA"
        )
        let viewModel = TurnViewModel()
        viewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "attachment-navigation", state: .loading)
        ]

        viewModel.saveLocalDraft(codex: service, threadID: "thread-navigation-attachment")
        let expectedRevision = service.composerDraftMergeRevision(for: "thread-navigation-attachment")
        viewModel.saveLifecycleLocalDraft(codex: service, threadID: "thread-navigation-attachment")

        XCTAssertEqual(
            service.composerDraftMergeRevision(for: "thread-navigation-attachment"),
            expectedRevision
        )

        TurnViewModel.completeAttachmentLoad(
            .ready(attachment),
            id: "attachment-navigation",
            viewModel: nil,
            expectedDraftMergeRevision: expectedRevision,
            codex: service,
            threadID: "thread-navigation-attachment"
        )

        XCTAssertEqual(service.composerDraft(for: "thread-navigation-attachment")?.attachments, [
            TurnComposerImageAttachment(id: "attachment-navigation", state: .ready(attachment))
        ])
    }

    func testDetachedAttachmentLoadMergesWithoutMutatingDisappearedView() {
        let service = makeService()
        let attachment = CodexImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,AAAA"
        )
        let viewModel = TurnViewModel()
        viewModel.input = "Use this image"
        viewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "attachment-detached", state: .loading)
        ]

        viewModel.saveLocalDraft(codex: service, threadID: "thread-detached-attachment")
        let expectedRevision = service.composerDraftMergeRevision(for: "thread-detached-attachment")
        viewModel.saveLifecycleLocalDraft(codex: service, threadID: "thread-detached-attachment")
        viewModel.cancelTransientTasks()

        TurnViewModel.completeAttachmentLoad(
            .ready(attachment),
            id: "attachment-detached",
            viewModel: viewModel,
            expectedDraftMergeRevision: expectedRevision,
            codex: service,
            threadID: "thread-detached-attachment"
        )

        XCTAssertEqual(viewModel.composerAttachments, [
            TurnComposerImageAttachment(id: "attachment-detached", state: .loading)
        ])
        XCTAssertEqual(viewModel.input, "Use this image")
        XCTAssertEqual(service.composerDraft(for: "thread-detached-attachment")?.attachments, [
            TurnComposerImageAttachment(id: "attachment-detached", state: .ready(attachment))
        ])

        viewModel.restoreSavedLocalDraftIfNeeded(codex: service, threadID: "thread-detached-attachment")

        XCTAssertEqual(viewModel.input, "Use this image")
        XCTAssertEqual(viewModel.composerAttachments, [
            TurnComposerImageAttachment(id: "attachment-detached", state: .ready(attachment))
        ])
        XCTAssertFalse(viewModel.hasBlockingAttachmentState)
    }

    func testReappearedDetachedAttachmentLoadUpdatesLiveTile() {
        let service = makeService()
        let attachment = CodexImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,AAAA"
        )
        let viewModel = TurnViewModel()
        viewModel.input = "Use this image"
        viewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "attachment-reappeared", state: .loading)
        ]

        viewModel.saveLocalDraft(codex: service, threadID: "thread-reappeared-attachment")
        let expectedRevision = service.composerDraftMergeRevision(for: "thread-reappeared-attachment")
        viewModel.saveLifecycleLocalDraft(codex: service, threadID: "thread-reappeared-attachment")
        viewModel.cancelTransientTasks()
        viewModel.restoreSavedLocalDraftIfNeeded(codex: service, threadID: "thread-reappeared-attachment")

        TurnViewModel.completeAttachmentLoad(
            .ready(attachment),
            id: "attachment-reappeared",
            viewModel: viewModel,
            expectedDraftMergeRevision: expectedRevision,
            attachmentOrder: ["attachment-reappeared"],
            codex: service,
            threadID: "thread-reappeared-attachment"
        )

        XCTAssertEqual(viewModel.composerAttachments, [
            TurnComposerImageAttachment(id: "attachment-reappeared", state: .ready(attachment))
        ])
        XCTAssertEqual(service.composerDraft(for: "thread-reappeared-attachment")?.attachments, [
            TurnComposerImageAttachment(id: "attachment-reappeared", state: .ready(attachment))
        ])
        XCTAssertFalse(viewModel.hasBlockingAttachmentState)
    }

    func testDetachedFailedAttachmentLoadUpdatesRetainedTile() {
        let service = makeService()
        let viewModel = TurnViewModel()
        viewModel.input = "Use this image"
        viewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "attachment-failed", state: .loading)
        ]

        viewModel.saveLocalDraft(codex: service, threadID: "thread-failed-attachment")
        let expectedRevision = service.composerDraftMergeRevision(for: "thread-failed-attachment")
        viewModel.saveLifecycleLocalDraft(codex: service, threadID: "thread-failed-attachment")
        viewModel.cancelTransientTasks()

        TurnViewModel.completeAttachmentLoad(
            .failed,
            id: "attachment-failed",
            viewModel: viewModel,
            expectedDraftMergeRevision: expectedRevision,
            attachmentOrder: ["attachment-failed"],
            codex: service,
            threadID: "thread-failed-attachment"
        )

        XCTAssertEqual(viewModel.composerAttachments, [
            TurnComposerImageAttachment(id: "attachment-failed", state: .failed)
        ])
        XCTAssertTrue(viewModel.hasBlockingAttachmentState)
        XCTAssertEqual(service.composerDraft(for: "thread-failed-attachment")?.attachments, [])
    }

    func testDetachedAttachmentLoadPreservesSelectedOrder() {
        let service = makeService()
        let firstAttachment = CodexImageAttachment(
            thumbnailBase64JPEG: "first-thumb",
            payloadDataURL: "data:image/jpeg;base64,FIRST"
        )
        let secondAttachment = CodexImageAttachment(
            thumbnailBase64JPEG: "second-thumb",
            payloadDataURL: "data:image/jpeg;base64,SECOND"
        )
        let viewModel = TurnViewModel()
        viewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "attachment-first", state: .loading),
            TurnComposerImageAttachment(id: "attachment-second", state: .loading),
        ]

        viewModel.saveLocalDraft(codex: service, threadID: "thread-ordered-attachments")
        let expectedRevision = service.composerDraftMergeRevision(for: "thread-ordered-attachments")
        let attachmentOrder = ["attachment-first", "attachment-second"]

        TurnViewModel.completeAttachmentLoad(
            .ready(secondAttachment),
            id: "attachment-second",
            viewModel: nil,
            expectedDraftMergeRevision: expectedRevision,
            attachmentOrder: attachmentOrder,
            codex: service,
            threadID: "thread-ordered-attachments"
        )
        TurnViewModel.completeAttachmentLoad(
            .ready(firstAttachment),
            id: "attachment-first",
            viewModel: nil,
            expectedDraftMergeRevision: expectedRevision,
            attachmentOrder: attachmentOrder,
            codex: service,
            threadID: "thread-ordered-attachments"
        )

        XCTAssertEqual(service.composerDraft(for: "thread-ordered-attachments")?.attachments, [
            TurnComposerImageAttachment(id: "attachment-first", state: .ready(firstAttachment)),
            TurnComposerImageAttachment(id: "attachment-second", state: .ready(secondAttachment)),
        ])
    }

    func testDraftEditsDoNotBlockPendingAttachmentMerge() {
        let service = makeService()
        let attachment = CodexImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,AAAA"
        )
        let viewModel = TurnViewModel()
        viewModel.input = "Describe this"
        viewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "attachment-edited", state: .loading)
        ]

        viewModel.saveLocalDraft(codex: service, threadID: "thread-edited-attachment")
        let expectedRevision = service.composerDraftMergeRevision(for: "thread-edited-attachment")
        viewModel.input = "Describe this in detail"
        viewModel.saveLocalDraft(codex: service, threadID: "thread-edited-attachment")

        TurnViewModel.completeAttachmentLoad(
            .ready(attachment),
            id: "attachment-edited",
            viewModel: nil,
            expectedDraftMergeRevision: expectedRevision,
            attachmentOrder: ["attachment-edited"],
            codex: service,
            threadID: "thread-edited-attachment"
        )

        XCTAssertEqual(service.composerDraftMergeRevision(for: "thread-edited-attachment"), expectedRevision)
        XCTAssertEqual(service.composerDraft(for: "thread-edited-attachment")?.input, "Describe this in detail")
        XCTAssertEqual(service.composerDraft(for: "thread-edited-attachment")?.attachments, [
            TurnComposerImageAttachment(id: "attachment-edited", state: .ready(attachment))
        ])
    }

    func testRemovedPendingAttachmentDoesNotMergeAfterLateCompletion() {
        let service = makeService()
        let attachment = CodexImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,AAAA"
        )
        let viewModel = TurnViewModel()
        viewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "attachment-removed", state: .loading)
        ]

        viewModel.saveLocalDraft(codex: service, threadID: "thread-removed-attachment")
        let expectedRevision = service.composerDraftMergeRevision(for: "thread-removed-attachment")
        viewModel.removeComposerAttachment(id: "attachment-removed")
        viewModel.saveLocalDraft(codex: service, threadID: "thread-removed-attachment")

        TurnViewModel.completeAttachmentLoad(
            .ready(attachment),
            id: "attachment-removed",
            viewModel: nil,
            expectedDraftMergeRevision: expectedRevision,
            attachmentOrder: ["attachment-removed"],
            codex: service,
            threadID: "thread-removed-attachment"
        )

        XCTAssertNil(service.composerDraft(for: "thread-removed-attachment"))
    }

    func testRemovedOnePendingAttachmentDoesNotMergeWhileSiblingStillLoads() {
        let service = makeService()
        let removedAttachment = CodexImageAttachment(
            thumbnailBase64JPEG: "removed-thumb",
            payloadDataURL: "data:image/jpeg;base64,REMOVED"
        )
        let keptAttachment = CodexImageAttachment(
            thumbnailBase64JPEG: "kept-thumb",
            payloadDataURL: "data:image/jpeg;base64,KEPT"
        )
        let viewModel = TurnViewModel()
        viewModel.input = "Use one image"
        viewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "attachment-removed", state: .loading),
            TurnComposerImageAttachment(id: "attachment-kept", state: .loading),
        ]

        viewModel.saveLocalDraft(codex: service, threadID: "thread-remove-one-attachment")
        let expectedRevision = service.composerDraftMergeRevision(for: "thread-remove-one-attachment")
        let attachmentOrder = ["attachment-removed", "attachment-kept"]
        viewModel.removeComposerAttachment(id: "attachment-removed")
        viewModel.saveLocalDraft(codex: service, threadID: "thread-remove-one-attachment")

        TurnViewModel.completeAttachmentLoad(
            .ready(removedAttachment),
            id: "attachment-removed",
            viewModel: nil,
            expectedDraftMergeRevision: expectedRevision,
            attachmentOrder: attachmentOrder,
            codex: service,
            threadID: "thread-remove-one-attachment"
        )
        TurnViewModel.completeAttachmentLoad(
            .ready(keptAttachment),
            id: "attachment-kept",
            viewModel: nil,
            expectedDraftMergeRevision: expectedRevision,
            attachmentOrder: attachmentOrder,
            codex: service,
            threadID: "thread-remove-one-attachment"
        )

        XCTAssertEqual(service.composerDraft(for: "thread-remove-one-attachment")?.attachments, [
            TurnComposerImageAttachment(id: "attachment-kept", state: .ready(keptAttachment))
        ])
    }
}
