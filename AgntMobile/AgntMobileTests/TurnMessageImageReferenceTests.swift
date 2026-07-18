// FILE: TurnMessageImageReferenceTests.swift
// Purpose: Verifies command and assistant image-reference parsing.
// Layer: Unit Test
// Exports: TurnMessageImageReferenceTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class TurnMessageImageReferenceTests: TurnMessageCachesTestCase {
    func testCommandOutputImageReferenceParserCombinesLsDirectoryAndOutputFile() {
        let reference = CommandOutputImageReferenceParser.firstReference(
            command: "/bin/zsh -lc 'ls -1 /Users/example/.codex/generated_images/turn-123'",
            outputTail: "hero image.png\nnotes.txt",
            cwd: "/Users/example/project"
        )

        XCTAssertEqual(
            reference?.path,
            "/Users/example/.codex/generated_images/turn-123/hero image.png"
        )
        XCTAssertEqual(reference?.fileName, "hero image.png")
    }

    func testCommandOutputImageReferenceParserFindsMarkdownImagePath() {
        let reference = CommandOutputImageReferenceParser.firstReference(
            command: "echo done",
            outputTail: "Created ![preview](/Users/example/project/out/mockup.webp)",
            cwd: "/Users/example/project"
        )

        XCTAssertEqual(reference?.path, "/Users/example/project/out/mockup.webp")
    }

    func testCommandOutputImageReferenceParserIgnoresGlobCandidates() {
        let reference = CommandOutputImageReferenceParser.firstReference(
            command: "rg --files -g '*.png'",
            outputTail: "*.png",
            cwd: "/Users/example/project"
        )

        XCTAssertNil(reference)
    }

    func testCommandOutputImageReferenceParserKeepsBracketedFileNames() {
        let reference = CommandOutputImageReferenceParser.firstReference(
            command: "echo done",
            outputTail: "/Users/example/project/Screenshot [1].png",
            cwd: "/Users/example/project"
        )

        XCTAssertEqual(reference?.path, "/Users/example/project/Screenshot [1].png")
    }

    func testCommandOutputImageReferenceParserKeepsTemporaryImagePaths() {
        let reference = CommandOutputImageReferenceParser.firstReference(
            command: "echo done",
            outputTail: "/tmp/agnt-preview.png",
            cwd: "/Users/example/project"
        )

        XCTAssertEqual(reference?.path, "/tmp/agnt-preview.png")
    }

    func testAssistantMarkdownImageReferenceParserFindsLocalImage() {
        let references = AssistantMarkdownImageReferenceParser.references(
            in: "Here it is:\n![wing](/Users/example/.codex/generated_images/turn/wing.png)"
        )

        XCTAssertEqual(references.count, 1)
        XCTAssertEqual(references.first?.path, "/Users/example/.codex/generated_images/turn/wing.png")
        XCTAssertEqual(references.first?.displayTitle, "wing")
    }

    func testAssistantMarkdownImageReferenceParserKeepsDuplicatePathsDistinct() {
        let references = AssistantMarkdownImageReferenceParser.references(
            in: """
            ![first](/Users/example/wing.png)
            ![second](/Users/example/wing.png)
            """
        )

        XCTAssertEqual(references.map(\.path), [
            "/Users/example/wing.png",
            "/Users/example/wing.png"
        ])
        XCTAssertEqual(Set(references.map(\.id)).count, 2)
    }

    func testAssistantMarkdownImageReferenceParserRemovesImageOnlyLines() {
        let visibleText = AssistantMarkdownImageReferenceParser.visibleTextRemovingImageSyntax(
            from: "Before\n![wing](/Users/example/wing.png)\nAfter"
        )

        XCTAssertEqual(visibleText, "Before\nAfter")
    }

    func testAssistantMarkdownImageReferenceParserIgnoresCodeExamples() {
        let text = """
        Inline `![inline](/Users/example/inline.png)` stays literal.

        `@agnt``markdown
        ![fenced](/Users/example/fenced.png)
        `@agnt``

        ![real](/Users/example/real.png)
        """

        let references = AssistantMarkdownImageReferenceParser.references(in: text)
        let visibleText = AssistantMarkdownImageReferenceParser.visibleTextRemovingImageSyntax(from: text)

        XCTAssertEqual(references.map(\.path), ["/Users/example/real.png"])
        XCTAssertTrue(visibleText.contains("`![inline](/Users/example/inline.png)`"))
        XCTAssertTrue(visibleText.contains("![fenced](/Users/example/fenced.png)"))
        XCTAssertFalse(visibleText.contains("![real](/Users/example/real.png)"))
    }

    func testAssistantMarkdownImageReferenceParserReadsEscapedAnglePathWithClosingParenthesis() {
        let path = "/Users/example/generated images/final)%20 mock.png"
        let markdownPath = CodexService.markdownImagePath(path)
        let text = "![Generated image](\(markdownPath))"

        let references = AssistantMarkdownImageReferenceParser.references(in: text)

        XCTAssertEqual(markdownPath, "</Users/example/generated images/final%29%2520 mock.png>")
        XCTAssertEqual(references.map(\.path), [path])
        XCTAssertEqual(
            CodexService.markdownImagePath("/Users/example/final%20mock.png"),
            "</Users/example/final%2520mock.png>"
        )
    }

    func testMessageRowRenderModelCachesAssistantImageReferences() {
        let text = "Before\n![wing](/Users/example/wing.png)\nAfter"
        let message = CodexMessage(
            id: "assistant-image-cache",
            threadId: "thread-1",
            role: .assistant,
            text: text
        )

        let renderModel = MessageRowRenderModelCache.model(for: message, displayText: text)

        XCTAssertEqual(renderModel.assistantImageReferences.first?.path, "/Users/example/wing.png")
        XCTAssertEqual(renderModel.assistantTextWithoutImageSyntax, "Before\nAfter")
        XCTAssertTrue(renderModel.assistantInlineContentSegments.isEmpty)
    }

    func testAssistantMarkdownSegmentsKeepTemporaryImagePosition() {
        let text = "Before\n![mobile](/tmp/sample-mobile.png)\nAfter"
        let segments = AssistantMarkdownImageReferenceParser.contentSegmentsPreservingTemporaryImages(from: text)

        XCTAssertEqual(segments.count, 3)
        XCTAssertEqual(segments[0], .text(id: 0, value: "Before\n"))
        XCTAssertEqual(segments[1], .image(AssistantMarkdownImageReference(
            path: "/tmp/sample-mobile.png",
            altText: "mobile",
            occurrenceIndex: 0
        )))
        XCTAssertEqual(segments[2], .text(id: 1, value: "\nAfter"))
    }

    func testAssistantMarkdownSegmentsLeaveGeneratedImageForTrailingPreview() {
        let text = """
        Before
        ![Generated image](/Users/example/.codex/generated_images/thread/wing.png)
        After
        """
        let segments = AssistantMarkdownImageReferenceParser.contentSegmentsPreservingTemporaryImages(from: text)

        XCTAssertEqual(segments, [.text(id: 0, value: "Before\n\nAfter")])
    }

    func testMessageRowRenderModelStripsImagesBeforeMermaidParsing() {
        let text = """
        Intro
        ![wing](/Users/example/wing.png)
        `@agnt``mermaid
        graph TD
          A --> B
        `@agnt``
        Outro
        """
        let message = CodexMessage(
            id: "assistant-image-mermaid-cache",
            threadId: "thread-1",
            role: .assistant,
            text: text
        )

        let renderModel = MessageRowRenderModelCache.model(for: message, displayText: text)
        let markdownSegments = renderModel.mermaidContent?.segments.compactMap { segment -> String? in
            if case .markdown(let markdown) = segment.kind {
                return markdown
            }
            return nil
        } ?? []

        XCTAssertEqual(renderModel.assistantImageReferences.first?.path, "/Users/example/wing.png")
        XCTAssertFalse(markdownSegments.joined(separator: "\n").contains("![wing]"))
    }
}
