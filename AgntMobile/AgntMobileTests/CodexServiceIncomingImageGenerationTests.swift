// FILE: CodexServiceIncomingImageGenerationTests.swift
// Purpose: Verifies generated-image item decoding from incoming runtime events.
// Layer: Unit Test
// Exports: CodexServiceIncomingImageGenerationTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingImageGenerationTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func testCompletedImageViewItemAppendsGeneratedImagePreview() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "image-\(UUID().uuidString)"
        let imagePath = "/Users/example/generated image.png"

        service.handleNotification(
            method: "item/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(itemID),
                    "type": .string("imageView"),
                    "path": .string(imagePath),
                ]),
            ])
        )

        let imageRows = service.messages(for: threadID).filter {
            $0.role == .assistant && $0.itemId == itemID
        }
        XCTAssertEqual(imageRows.count, 1)
        XCTAssertEqual(imageRows[0].turnId, turnID)
        XCTAssertEqual(imageRows[0].text, "![Generated image](</Users/example/generated image.png>)")
    }

    func testDirectCompletedImageViewItemAppendsGeneratedImagePreview() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "image-\(UUID().uuidString)"
        let imagePath = "/Users/example/generated image.png"

        service.handleNotification(
            method: "item/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "id": .string(itemID),
                "type": .string("imageView"),
                "path": .string(imagePath),
            ])
        )

        let imageRows = service.messages(for: threadID).filter {
            $0.role == .assistant && $0.itemId == itemID
        }
        XCTAssertEqual(imageRows.count, 1)
        XCTAssertEqual(imageRows[0].turnId, turnID)
        XCTAssertEqual(imageRows[0].text, "![Generated image](</Users/example/generated image.png>)")
    }

    func testCompletedImageGenerationItemTypeAppendsGeneratedImagePreview() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "image-\(UUID().uuidString)"
        let imagePath = "/Users/example/generated image.png"

        service.handleNotification(
            method: "item/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(itemID),
                    "type": .string("image_generation"),
                    "path": .string(imagePath),
                    "result": .string("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"),
                ]),
            ])
        )

        let imageRows = service.messages(for: threadID).filter {
            $0.role == .assistant && $0.itemId == itemID
        }
        XCTAssertEqual(imageRows.count, 1)
        XCTAssertEqual(imageRows[0].turnId, turnID)
        XCTAssertEqual(imageRows[0].text, "![Generated image](</Users/example/generated image.png>)")
    }

    func testLegacyNamedImageGenerationEndAppendsGeneratedImagePreview() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "image-\(UUID().uuidString)"
        let imagePath = "/Users/example/generated image.png"

        service.handleNotification(
            method: "codex/event/image_generation_end",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("image_generation_end"),
                    "call_id": .string(itemID),
                    "turn_id": .string(turnID),
                    "saved_path": .string(imagePath),
                ]),
            ])
        )

        let imageRows = service.messages(for: threadID).filter {
            $0.role == .assistant && $0.itemId == itemID
        }
        XCTAssertEqual(imageRows.count, 1)
        XCTAssertEqual(imageRows[0].turnId, turnID)
        XCTAssertEqual(imageRows[0].text, "![Generated image](</Users/example/generated image.png>)")
    }

    func testCompletedImageGenerationItemAppendsGeneratedImagePreview() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "image-\(UUID().uuidString)"
        let imagePath = "/Users/example/generated image.png"

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

        let imageRows = service.messages(for: threadID).filter {
            $0.role == .assistant && $0.itemId == itemID
        }
        XCTAssertEqual(imageRows.count, 1)
        XCTAssertEqual(imageRows[0].turnId, turnID)
        XCTAssertEqual(imageRows[0].text, "![Generated image](</Users/example/generated image.png>)")
    }

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

    private func makeService() -> CodexService {
        let suiteName = "CodexServiceIncomingImageGenerationTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]
        Self.retainedServices.append(service)
        return service
    }
}
