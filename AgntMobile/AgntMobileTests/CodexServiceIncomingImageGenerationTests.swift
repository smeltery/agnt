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
