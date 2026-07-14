// FILE: TurnTimelineCompletedTurnProjectionTests.swift
// Purpose: Verifies completed-turn timeline render projection collapse behavior.
// Layer: Unit Test
// Exports: TurnTimelineCompletedTurnProjectionTests
// Depends on: XCTest, SwiftUI, AgntMobile

import XCTest
import SwiftUI
@testable import AgntMobile

final class TurnTimelineCompletedTurnProjectionTests: XCTestCase {
func testTimelineRenderProjectionMovesCompletedCommandsIntoPreviousMessages() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "user",
            threadID: "thread",
            role: .user,
            text: "Run the checks",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "command-1",
            threadID: "thread",
            role: .system,
            kind: .commandExecution,
            text: "Completed npm test",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "command-1",
            orderIndex: 2
        ),
        makeTimelineTestMessage(
            id: "reasoning",
            threadID: "thread",
            role: .system,
            kind: .thinking,
            text: "Reasoning summary after the command",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "reasoning",
            orderIndex: 3
        ),
        makeTimelineTestMessage(
            id: "command-2",
            threadID: "thread",
            role: .system,
            kind: .commandExecution,
            text: "Completed git diff --check",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            itemID: "command-2",
            orderIndex: 4
        ),
        makeTimelineTestMessage(
            id: "final",
            threadID: "thread",
            role: .assistant,
            text: "Checks passed.",
            createdAt: now.addingTimeInterval(4),
            turnID: "turn-1",
            itemID: "final-item",
            orderIndex: 5
        ),
    ]

    let items = TurnTimelineRenderProjection.project(
        messages: messages,
        completedTurnIDs: ["turn-1"]
    )

    XCTAssertEqual(items.map(\.id), ["user", "previous-messages:final", "final"])
    guard case .previousMessages(let previousGroup) = items[1] else {
        return XCTFail("Expected completed command trace inside previous messages")
    }
    XCTAssertEqual(previousGroup.messages.map(\.id), ["command-1", "reasoning", "command-2"])
}

func testTimelineProjectionKeepsPreviousMessagesChronologicalForMultiAssistantTurns() {
    let now = Date()
    let rawMessages = [
        makeTimelineTestMessage(
            id: "user",
            threadID: "thread",
            role: .user,
            text: "Check Gmail",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "status",
            threadID: "thread",
            role: .assistant,
            text: "I'll use the Gmail connector.",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "status-item",
            orderIndex: 2
        ),
        makeTimelineTestMessage(
            id: "tool",
            threadID: "thread",
            role: .system,
            kind: .toolActivity,
            text: "Read inbox",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "tool-item",
            orderIndex: 3
        ),
        makeTimelineTestMessage(
            id: "final-a",
            threadID: "thread",
            role: .assistant,
            text: "The latest agnt TestFlight inbox email says: Version 1.4, build 126.",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            itemID: "final-item-a",
            orderIndex: 4
        ),
        makeTimelineTestMessage(
            id: "final-b",
            threadID: "thread",
            role: .assistant,
            text: "The latest agnt TestFlight inbox email says: Version 1.4, build 126.",
            createdAt: now.addingTimeInterval(4),
            turnID: "turn-1",
            itemID: "final-item-b",
            orderIndex: 5
        ),
    ]

    let projectedMessages = TurnTimelineReducer.project(messages: rawMessages).messages
    XCTAssertEqual(projectedMessages.map(\.id), ["user", "status", "tool", "final-a"])

    let items = TurnTimelineRenderProjection.project(
        messages: projectedMessages,
        completedTurnIDs: ["turn-1"]
    )

    guard case .message(let user) = items[0],
          case .previousMessages(let previousGroup) = items[1],
          case .message(let final) = items[2] else {
        return XCTFail("Expected user, previous-messages disclosure, final answer")
    }

    XCTAssertEqual(user.id, "user")
    XCTAssertEqual(previousGroup.messages.map(\.id), ["status", "tool"])
    XCTAssertEqual(final.id, "final-a")
}

func testTimelineProjectionSkipsFinalReplaysAndMergedImageArtifactsInPreviousMessages() {
    let now = Date()
    let imagePath = "/Users/example/.codex/generated_images/thread/generated-icon.png"
    let finalText = """
    Created the icon with `$imagegen` using the built-in image generation mode.

    TL;DR:
    The icon shows the user as calm, focused, and in control.

    ![Generated image](\(imagePath))
    """
    let messages = [
        makeTimelineTestMessage(
            id: "user",
            threadID: "thread",
            role: .user,
            text: "Create an app user icon",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "intro",
            threadID: "thread",
            role: .assistant,
            text: "I will use the imagegen skill and inspect the app tone.",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            orderIndex: 2
        ),
        makeTimelineTestMessage(
            id: "context",
            threadID: "thread",
            role: .assistant,
            text: "The site is for agnt: an iPhone bridge with a local-first power-user tone.",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            orderIndex: 3
        ),
        makeTimelineTestMessage(
            id: "leaked-tldr",
            threadID: "thread",
            role: .assistant,
            text: "TL;DR:\nThe icon shows the user as calm, focused, and in control.",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            orderIndex: 4
        ),
        makeTimelineTestMessage(
            id: "image-artifact",
            threadID: "thread",
            role: .assistant,
            text: "![Generated image](\(imagePath))",
            createdAt: now.addingTimeInterval(4),
            turnID: "turn-1",
            orderIndex: 5
        ),
        makeTimelineTestMessage(
            id: "final",
            threadID: "thread",
            role: .assistant,
            text: finalText,
            createdAt: now.addingTimeInterval(5),
            turnID: "turn-1",
            orderIndex: 6
        ),
    ]

    let items = TurnTimelineRenderProjection.project(
        messages: messages,
        completedTurnIDs: ["turn-1"]
    )

    XCTAssertEqual(items.count, 3)
    guard case .previousMessages(let previousGroup) = items[1],
          case .message(let final) = items[2] else {
        return XCTFail("Expected previous-message disclosure followed by the final answer")
    }

    XCTAssertEqual(previousGroup.messages.map(\.id), ["intro", "context"])
    XCTAssertEqual(final.id, "final")
}

func testTimelineProjectionMovesGeneratedImageArtifactToFinalAnswer() {
    let now = Date()
    let imagePath = "/Users/example/.codex/generated_images/thread/generated-icon.png"
    let introText = "Using imagegen for a fresh raster icon concept. I will make it feel calm."
    let finalText = """
    TL;DR: The icon shows the user becoming calm, focused, and in control.

    The glowing path/grid represents organized direction.
    """
    let imageMarkdown = "![Generated image](\(imagePath))"
    let messages = [
        makeTimelineTestMessage(
            id: "user",
            threadID: "thread",
            role: .user,
            text: "Create an app user icon",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "intro",
            threadID: "thread",
            role: .assistant,
            text: introText,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            orderIndex: 2
        ),
        makeTimelineTestMessage(
            id: "image-artifact",
            threadID: "thread",
            role: .assistant,
            text: imageMarkdown,
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            orderIndex: 3
        ),
        makeTimelineTestMessage(
            id: "final",
            threadID: "thread",
            role: .assistant,
            text: "\(introText)\n\n\(finalText)",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            orderIndex: 4
        ),
    ]

    let items = TurnTimelineRenderProjection.project(
        messages: messages,
        completedTurnIDs: ["turn-1"]
    )

    XCTAssertEqual(items.count, 3)
    guard case .previousMessages(let previousGroup) = items[1],
          case .message(let final) = items[2] else {
        return XCTFail("Expected one previous prose row followed by a normalized final answer")
    }

    XCTAssertEqual(previousGroup.messages.map(\.id), ["intro"])
    XCTAssertFalse(final.text.contains(introText))
    XCTAssertEqual(
        final.text,
        "\(finalText.trimmingCharacters(in: .whitespacesAndNewlines))\n\n\(imageMarkdown)"
    )
}

func testTimelineProjectionUsesAssistantPhaseForPreviousMessageCount() {
    let now = Date()
    let imagePath = "/Users/example/.codex/generated_images/thread/generated-icon.png"
    let commentary = "Using imagegen because this is a new raster icon concept. I will keep the TLDR tight."
    let finalText = "TLDR: The icon shows the user becoming calm, focused, and in control."
    let imageMarkdown = "![Generated image](\(imagePath))"
    let messages = [
        makeTimelineTestMessage(
            id: "user",
            threadID: "thread",
            role: .user,
            text: "Create an icon",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "commentary",
            threadID: "thread",
            role: .assistant,
            assistantPhase: "commentary",
            text: commentary,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "commentary-item",
            orderIndex: 2
        ),
        makeTimelineTestMessage(
            id: "image",
            threadID: "thread",
            role: .assistant,
            text: imageMarkdown,
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "image-item",
            orderIndex: 3
        ),
        makeTimelineTestMessage(
            id: "final",
            threadID: "thread",
            role: .assistant,
            assistantPhase: "final_answer",
            text: finalText,
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            itemID: "final-item",
            orderIndex: 4
        ),
    ]

    let items = TurnTimelineRenderProjection.project(
        messages: messages,
        completedTurnIDs: ["turn-1"]
    )

    XCTAssertEqual(items.count, 3)
    guard case .previousMessages(let previousGroup) = items[1],
          case .message(let final) = items[2] else {
        return XCTFail("Expected commentary behind one previous-message disclosure and final with generated image")
    }

    XCTAssertEqual(previousGroup.messages.map(\.id), ["commentary"])
    XCTAssertEqual(final.text, "\(finalText)\n\n\(imageMarkdown)")
}

func testTimelineProjectionKeepsPriorityArtifactsVisibleOutsidePreviousMessages() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "user",
            threadID: "thread",
            role: .user,
            text: "Build the feature",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "thinking",
            threadID: "thread",
            role: .system,
            kind: .thinking,
            text: "Reasoning",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            orderIndex: 2
        ),
        makeTimelineTestMessage(
            id: "assistant-status",
            threadID: "thread",
            role: .assistant,
            text: "I am checking the repo.",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "status-item",
            orderIndex: 3
        ),
        makeTimelineTestMessage(
            id: "tool",
            threadID: "thread",
            role: .system,
            kind: .toolActivity,
            text: "Read Sources/App.swift",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            orderIndex: 4
        ),
        makeTimelineTestMessage(
            id: "file-change",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: "Path: Sources/App.swift\nKind: update\nTotals: +1 -0",
            createdAt: now.addingTimeInterval(4),
            turnID: "turn-1",
            orderIndex: 5
        ),
        makeTimelineTestMessage(
            id: "image",
            threadID: "thread",
            role: .assistant,
            text: "![Generated image](/Users/example/generated.png)",
            createdAt: now.addingTimeInterval(5),
            turnID: "turn-1",
            itemID: "image-item",
            orderIndex: 6
        ),
        makeTimelineTestMessage(
            id: "comment-card",
            threadID: "thread",
            role: .assistant,
            text: #"::code-comment{title="[P2] Keep artifact visible" body="The action card should stay visible outside previous messages." file="Sources/App.swift" start=10 end=12 priority=2 confidence=0.82}"#,
            createdAt: now.addingTimeInterval(5.5),
            turnID: "turn-1",
            itemID: "comment-item",
            orderIndex: 7
        ),
        makeTimelineTestMessage(
            id: "final",
            threadID: "thread",
            role: .assistant,
            text: "Done. The feature is ready.",
            createdAt: now.addingTimeInterval(6),
            turnID: "turn-1",
            itemID: "final-item",
            orderIndex: 8
        ),
        makeTimelineTestMessage(
            id: "post-tool",
            threadID: "thread",
            role: .system,
            kind: .toolActivity,
            text: "Late metadata refresh",
            createdAt: now.addingTimeInterval(7),
            turnID: "turn-1",
            orderIndex: 9
        ),
    ]

    let items = TurnTimelineRenderProjection.project(
        messages: messages,
        completedTurnIDs: ["turn-1"]
    )

    XCTAssertEqual(items.map(\.id), [
        "user",
        "previous-messages:final",
        "file-change",
        "image",
        "comment-card",
        "final",
    ])
    guard case .previousMessages(let previousGroup) = items[1] else {
        return XCTFail("Expected previous messages disclosure before priority artifacts")
    }
    XCTAssertEqual(previousGroup.messages.map(\.id), ["thinking", "assistant-status", "tool", "post-tool"])
}
}
