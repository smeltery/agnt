// FILE: CodexServiceImageGenerationMergeTests.swift
// Purpose: Verifies late generated-image preview merging into assistant answers.
// Layer: Unit Test
// Exports: CodexServiceImageGenerationMergeTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceImageGenerationMergeTests: CodexServiceImageGenerationTestCase {
    func testLateGeneratedImageMergesIntoAssistantAnswerForSameTurn() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "image-\(UUID().uuidString)"
        let imagePath = "/Users/example/generated image.png"

        service.appendMessage(
            CodexMessage(
                id: "assistant-final",
                threadId: threadID,
                role: .assistant,
                text: "Done: generated the image.",
                turnId: turnID,
                isStreaming: false
            )
        )

        service.handleNotification(
            method: "item/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(itemID),
                    "type": .string("image_generation_call"),
                    "saved_path": .string(imagePath),
                ]),
            ])
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(assistantMessages[0].id, "assistant-final")
        XCTAssertEqual(
            assistantMessages[0].text,
            "Done: generated the image.\n\n![Generated image](</Users/example/generated image.png>)"
        )
        XCTAssertNil(assistantMessages[0].itemId)
    }

    func testLateGeneratedImageDoesNotFinishStreamingAssistantAnswer() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "image-\(UUID().uuidString)"
        let imagePath = "/Users/example/generated image.png"

        service.appendMessage(
            CodexMessage(
                id: "assistant-streaming",
                threadId: threadID,
                role: .assistant,
                text: "Generating",
                turnId: turnID,
                isStreaming: true
            )
        )

        service.handleNotification(
            method: "item/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(itemID),
                    "type": .string("image_generation_call"),
                    "saved_path": .string(imagePath),
                ]),
            ])
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 2)
        XCTAssertEqual(assistantMessages[0].id, "assistant-streaming")
        XCTAssertTrue(assistantMessages[0].isStreaming)
        XCTAssertEqual(assistantMessages[0].text, "Generating")
        XCTAssertEqual(assistantMessages[1].itemId, itemID)
        XCTAssertEqual(assistantMessages[1].text, "![Generated image](</Users/example/generated image.png>)")
    }

    func testLateGeneratedImageDoesNotReplaceAssistantAnswerItemIdentity() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let answerItemID = "answer-\(UUID().uuidString)"
        let imageItemID = "image-\(UUID().uuidString)"
        let imagePath = "/Users/example/generated image.png"

        service.appendMessage(
            CodexMessage(
                id: "assistant-final",
                threadId: threadID,
                role: .assistant,
                text: "Done: generated the image.",
                turnId: turnID,
                itemId: answerItemID,
                isStreaming: false
            )
        )

        service.handleNotification(
            method: "item/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(imageItemID),
                    "type": .string("image_generation_call"),
                    "saved_path": .string(imagePath),
                ]),
            ])
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(assistantMessages[0].id, "assistant-final")
        XCTAssertEqual(assistantMessages[0].itemId, answerItemID)
        XCTAssertEqual(
            assistantMessages[0].text,
            "Done: generated the image.\n\n![Generated image](</Users/example/generated image.png>)"
        )
    }

    func testDuplicateLateGeneratedImageDoesNotAdoptImageItemIdentity() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let imageItemID = "image-\(UUID().uuidString)"
        let imagePath = "/Users/example/generated image.png"

        service.appendMessage(
            CodexMessage(
                id: "assistant-final",
                threadId: threadID,
                role: .assistant,
                text: "Done: generated the image.",
                turnId: turnID,
                isStreaming: false
            )
        )

        let params: JSONValue = .object([
            "threadId": .string(threadID),
            "turnId": .string(turnID),
            "item": .object([
                "id": .string(imageItemID),
                "type": .string("image_generation_call"),
                "saved_path": .string(imagePath),
            ]),
        ])

        service.handleNotification(method: "item/completed", params: params)
        service.handleNotification(method: "item/completed", params: params)

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(assistantMessages[0].id, "assistant-final")
        XCTAssertNil(assistantMessages[0].itemId)
        XCTAssertEqual(
            assistantMessages[0].text,
            "Done: generated the image.\n\n![Generated image](</Users/example/generated image.png>)"
        )
    }

    func testCanonicalItemCompletionPreservesLateTurnImagePreview() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let imagePath = "/Users/example/.codex/generated_images/thread/generated-preview.png"

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: nil,
            text: "Here is the generated image."
        )
        service.appendGeneratedImageReference(
            threadId: threadID,
            turnId: turnID,
            itemId: "image-item",
            imagePath: imagePath
        )
        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: "prose-item",
            text: "Here is the final generated image."
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(assistantMessages.first?.itemId, "prose-item")
        XCTAssertEqual(
            assistantMessages.first?.text,
            "Here is the final generated image.\n\n![Generated image](\(imagePath))"
        )
    }

    func testFinalReplayCompletionAbsorbsPriorImagePreviewBubble() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let introText = "Using the imagegen skill for this as a new bitmap icon asset."
        let finalText = "Done. Generated a polished wing icon image using the built-in image generation tool."
        let imagePath = "/Users/example/.codex/generated_images/thread/generated-wing.png"

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: "intro-item",
            text: introText
        )
        service.appendGeneratedImageReference(
            threadId: threadID,
            turnId: turnID,
            itemId: "image-item",
            imagePath: imagePath
        )
        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: "final-item",
            text: "\(finalText)\n\n\(introText)"
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(
            assistantMessages.first?.text,
            "\(finalText)\n\n![Generated image](\(imagePath))"
        )
    }

    func testFinalCompletionAfterImagePreviewReplacesPreparatoryBubble() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let introText = "Using the imagegen skill for this as a new raster icon asset."
        let finalText = "Generated a clean wing icon image using the built-in image generator."
        let imagePath = "/Users/example/.codex/generated_images/thread/generated-wing.png"

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: nil,
            text: introText
        )
        service.appendGeneratedImageReference(
            threadId: threadID,
            turnId: turnID,
            itemId: "image-item",
            imagePath: imagePath
        )
        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: nil,
            text: finalText
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(
            assistantMessages.first?.text,
            "\(finalText)\n\n![Generated image](\(imagePath))"
        )
    }

    func testTurnlessFinalAnswerCompletionUsesActiveTurnImagePreview() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let introText = "Preparing an image asset for the current request."
        let finalText = "Generated a clean wing icon image using the built-in image generator."
        let imagePath = "/Users/example/.codex/generated_images/thread/generated-wing.png"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)
        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: nil,
            text: introText
        )
        service.appendGeneratedImageReference(
            threadId: threadID,
            turnId: nil,
            itemId: "image-item",
            imagePath: imagePath
        )
        service.handleNotification(
            method: "codex/event/agent_message",
            params: .object([
                "threadId": .string(threadID),
                "msg": .object([
                    "type": .string("agent_message"),
                    "phase": .string("final_answer"),
                    "message": .string(finalText),
                ]),
            ])
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(assistantMessages.first?.turnId, turnID)
        XCTAssertEqual(
            assistantMessages.first?.text,
            "\(finalText)\n\n![Generated image](\(imagePath))"
        )
    }

    func testItemScopedCompletionAfterImagePreviewStaysSeparate() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let introText = "Preparing an image asset for the current request."
        let laterItemText = "Here is a separate assistant item in the same turn."
        let imagePath = "/Users/example/.codex/generated_images/thread/generated-wing.png"

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: nil,
            text: introText
        )
        service.appendGeneratedImageReference(
            threadId: threadID,
            turnId: turnID,
            itemId: "image-item",
            imagePath: imagePath
        )
        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: "later-assistant-item",
            text: laterItemText
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 2)
        XCTAssertEqual(
            assistantMessages.first?.text,
            "\(introText)\n\n![Generated image](\(imagePath))"
        )
        XCTAssertEqual(assistantMessages.last?.text, laterItemText)
    }

    func testTurnFinalCompletionDoesNotAbsorbTemporaryImageArtifact() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let tmpMarkdown = "![sample-mobile](/tmp/sample-mobile.png)"

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: "intro-item",
            text: "Checking mobile capture."
        )
        service.appendMessage(CodexMessage(
            threadId: threadID,
            role: .assistant,
            text: tmpMarkdown,
            turnId: turnID,
            itemId: "tmp-image-item",
            isStreaming: false
        ))
        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: "final-item",
            text: "Overall\nScore: 3.9/5"
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.map(\.text), [
            "Checking mobile capture.",
            tmpMarkdown,
            "Overall\nScore: 3.9/5",
        ])
    }

    func testCanonicalCompletionDoesNotAppendTemporaryImageToEnd() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "assistant-item"

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: itemID,
            text: "Before\n![mobile](/tmp/sample-mobile.png)\nAfter"
        )
        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: itemID,
            text: "Canonical final text"
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.map(\.text), ["Canonical final text"])
    }
}
