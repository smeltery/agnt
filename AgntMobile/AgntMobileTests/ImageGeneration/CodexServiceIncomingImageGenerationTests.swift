// FILE: CodexServiceIncomingImageGenerationTests.swift
// Purpose: Verifies generated-image item decoding from incoming runtime events.
// Layer: Unit Test
// Exports: CodexServiceIncomingImageGenerationTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingImageGenerationTests: CodexServiceImageGenerationTestCase {
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
}
