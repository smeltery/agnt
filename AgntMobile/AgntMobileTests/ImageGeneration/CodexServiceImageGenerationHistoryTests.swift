// FILE: CodexServiceImageGenerationHistoryTests.swift
// Purpose: Verifies generated-image history decode and merge cleanup behavior.
// Layer: Unit Test
// Exports: CodexServiceImageGenerationHistoryTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceImageGenerationHistoryTests: CodexServiceImageGenerationTestCase {
    func testHistoryDecodeMergesGeneratedImageArtifactIntoFinalAssistantAnswer() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let introText = "Preparing an image asset for the current request."
        let finalText = "Generated a clean wing icon image using the built-in image generator."
        let imagePath = "/Users/example/.codex/generated_images/thread/generated-wing.png"

        let messages = service.decodeMessagesFromThreadRead(
            threadId: threadID,
            threadObject: [
                "turns": .array([
                    .object([
                        "id": .string(turnID),
                        "items": .array([
                            .object([
                                "id": .string("intro-item"),
                                "type": .string("agentMessage"),
                                "content": .array([
                                    .object([
                                        "type": .string("output_text"),
                                        "text": .string(introText),
                                    ]),
                                ]),
                            ]),
                            .object([
                                "id": .string("image-item"),
                                "type": .string("imageGenerationCall"),
                                "file_path": .string(imagePath),
                            ]),
                            .object([
                                "id": .string("final-item"),
                                "type": .string("agentMessage"),
                                "content": .array([
                                    .object([
                                        "type": .string("output_text"),
                                        "text": .string(finalText),
                                    ]),
                                ]),
                            ]),
                        ]),
                    ]),
                ]),
            ]
        )

        let assistantMessages = messages.filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 2)
        XCTAssertEqual(assistantMessages.first?.text, introText)
        XCTAssertEqual(
            assistantMessages.last?.text,
            "\(finalText)\n\n![Generated image](\(imagePath))"
        )
    }

    func testHistoryMergeLeavesTemporaryImageArtifactInOriginalOrder() {
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let tmpMarkdown = "![sample-mobile](/tmp/sample-mobile.png)"
        let messages = [
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "Checking mobile capture.",
                turnId: turnID,
                itemId: "intro-item",
                isStreaming: false
            ),
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: tmpMarkdown,
                turnId: turnID,
                itemId: "tmp-image-item",
                isStreaming: false
            ),
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "Overall\nScore: 3.9/5",
                turnId: turnID,
                itemId: "final-item",
                isStreaming: false
            ),
        ]

        let merged = CodexService.historyMessagesMergingGeneratedImageArtifacts(messages)

        XCTAssertEqual(merged.map(\.text), [
            "Checking mobile capture.",
            tmpMarkdown,
            "Overall\nScore: 3.9/5",
        ])
    }

    func testHistoryMergeCleansExistingDuplicateGeneratedImageArtifact() throws {
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let introText = "Preparing an image asset for the current request."
        let finalText = "Generated a clean wing icon image using the built-in image generator."
        let imagePath = "/Users/example/.codex/generated_images/thread/generated-wing.png"
        let imageMarkdown = "![Generated image](\(imagePath))"

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "\(introText)\n\n\(imageMarkdown)",
                turnId: turnID,
                itemId: "intro-item",
                isStreaming: false
            ),
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: finalText,
                turnId: turnID,
                itemId: "final-item",
                isStreaming: false
            ),
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: imageMarkdown,
                turnId: turnID,
                itemId: "image-item",
                isStreaming: false
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: introText,
                turnId: turnID,
                itemId: "intro-item",
                isStreaming: false
            ),
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "\(finalText)\n\n\(imageMarkdown)",
                turnId: turnID,
                itemId: "final-item",
                isStreaming: false
            ),
        ]

        let merged = try CodexService.mergeHistoryMessages(
            existing,
            history,
            activeThreadIDs: [],
            runningThreadIDs: []
        ).filter { $0.role == .assistant }

        XCTAssertEqual(merged.count, 2)
        XCTAssertEqual(merged.first?.text, introText)
        XCTAssertEqual(merged.last?.text, "\(finalText)\n\n\(imageMarkdown)")
    }
}
