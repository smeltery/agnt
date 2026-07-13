// FILE: TurnTimelineMarkdownRenderingTests.swift
// Purpose: Verifies markdown and Mermaid rendering helpers.
// Layer: Unit Test
// Exports: TurnTimelineMarkdownRenderingTests
// Depends on: XCTest, SwiftUI, AgntMobile

import XCTest
import SwiftUI
@testable import AgntMobile

final class TurnTimelineMarkdownRenderingTests: XCTestCase {
func testParseMarkdownSegmentsSupportsPlusLanguageTags() {
    let source = """
    Intro

    `@agnt``c++
    int main() { return 0; }
    `@agnt``

    Outro
    """

    let segments = parseMarkdownSegments(source)
    let codeLanguages = segments.compactMap { segment -> String? in
        if case .codeBlock(let language, _) = segment {
            return language
        }
        return nil
    }

    XCTAssertEqual(codeLanguages, ["c++"])
}

func testParseMarkdownSegmentsSupportsDashedLanguageTags() {
    let source = """
    `@agnt``objective-c
    @implementation Example
    @end
    `@agnt``
    """

    let segments = parseMarkdownSegments(source)
    let codeLanguages = segments.compactMap { segment -> String? in
        if case .codeBlock(let language, _) = segment {
            return language
        }
        return nil
    }

    XCTAssertEqual(codeLanguages, ["objective-c"])
}

func testMermaidMarkdownContentParsesMermaidBlocks() {
    let source = """
    Intro

    `@agnt``mermaid
    flowchart TD
        A[Start] --> B[End]
    `@agnt``

    Outro
    """

    let content = MermaidMarkdownContentCache.content(messageID: "mermaid-basic", text: source)

    XCTAssertEqual(mermaidSegmentKinds(in: content), [.markdown, .mermaid, .markdown])
}

func testMermaidMarkdownContentSupportsMultipleBlocks() {
    let source = """
    `@agnt``mermaid
    flowchart TD
        A --> B
    `@agnt``

    Middle

    `@agnt``mermaid
    sequenceDiagram
        Alice->>Bob: hi
    `@agnt``
    """

    let content = MermaidMarkdownContentCache.content(messageID: "mermaid-multi", text: source)

    XCTAssertEqual(mermaidSegmentKinds(in: content), [.mermaid, .markdown, .mermaid])
}

func testMermaidMarkdownContentIgnoresPlainCodeBlocks() {
    let source = """
    `@agnt``swift
    let text = \"`@agnt``mermaid\"
    `@agnt``
    """

    let content = MermaidMarkdownContentCache.content(messageID: "mermaid-ignore", text: source)

    XCTAssertNil(content)
}

func testMermaidSourceNormalizerConvertsLooseArrowLabels() {
    let source = """
    W -- Yes --> X[Relay replaces old Mac socket<br/>4001 to old connection]
    """

    let normalized = MermaidSourceNormalizer.normalized(source)

    XCTAssertEqual(
        normalized,
        "W -->|Yes| X[Relay replaces old Mac socket<br/>4001 to old connection]"
    )
}

func testMermaidSourceNormalizerLeavesValidArrowLabelsUntouched() {
    let source = """
    W -->|Yes| X[Relay replaces old Mac socket<br/>4001 to old connection]
    """

    let normalized = MermaidSourceNormalizer.normalized(source)

    XCTAssertEqual(normalized, source)
}

func testMermaidSourceNormalizerQuotesSquareNodeLabels() {
    let source = """
    X[Relay replaces old Mac socket<br/>4001 to old connection]
    """

    let normalized = MermaidSourceNormalizer.normalized(source)

    XCTAssertEqual(
        normalized,
        #"X["Relay replaces old Mac socket<br/>4001 to old connection"]"#
    )
}

func testMermaidSourceNormalizerQuotesDecisionNodeLabels() {
    let source = """
    W{Mac reconnects?}
    """

    let normalized = MermaidSourceNormalizer.normalized(source)

    XCTAssertEqual(normalized, #"W{"Mac reconnects?"}"#)
}

func testAssistantRenderModelDefersMermaidUntilStreamingCompletes() {
    MessageRowRenderModelCache.reset()
    MermaidMarkdownContentCache.reset()

    let source = """
    Intro

    `@agnt``mermaid
    flowchart TD
        A[Start] --> B[End]
    `@agnt``
    """
    let displayText = source.trimmingCharacters(in: .whitespacesAndNewlines)
    var message = makeTimelineTestMessage(
        id: "assistant-mermaid-streaming",
        threadID: "thread",
        role: .assistant,
        text: source,
        isStreaming: true
    )

    let streamingModel = MessageRowRenderModelCache.model(for: message, displayText: displayText)
    XCTAssertNil(streamingModel.mermaidContent)

    message.isStreaming = false

    let finalizedModel = MessageRowRenderModelCache.model(for: message, displayText: displayText)
    XCTAssertEqual(mermaidSegmentKinds(in: finalizedModel.mermaidContent), [.markdown, .mermaid])
}
}

private enum MarkdownSegment {
    case text(String)
    case codeBlock(language: String?, code: String)
}

private enum MermaidSegmentKind: Equatable {
    case markdown
    case mermaid
}

private func parseMarkdownSegments(_ source: String) -> [MarkdownSegment] {
    let lines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var segments: [MarkdownSegment] = []
    var currentText: [String] = []
    var currentCode: [String] = []
    var currentLanguage: String?
    var isInsideCodeBlock = false

    func flushText() {
        guard !currentText.isEmpty else { return }
        segments.append(.text(currentText.joined(separator: "\n")))
        currentText.removeAll(keepingCapacity: true)
    }

    func flushCode() {
        segments.append(.codeBlock(language: currentLanguage, code: currentCode.joined(separator: "\n")))
        currentCode.removeAll(keepingCapacity: true)
        currentLanguage = nil
    }

    for line in lines {
        if line.hasPrefix("`@agnt``") {
            if isInsideCodeBlock {
                flushCode()
                isInsideCodeBlock = false
            } else {
                flushText()
                let languageTag = String(line.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
                currentLanguage = languageTag.isEmpty ? nil : languageTag
                isInsideCodeBlock = true
            }
            continue
        }

        if isInsideCodeBlock {
            currentCode.append(line)
        } else {
            currentText.append(line)
        }
    }

    if isInsideCodeBlock {
        flushCode()
    } else {
        flushText()
    }

    return segments
}

private func mermaidSegmentKinds(in content: MermaidMarkdownContent?) -> [MermaidSegmentKind] {
    guard let content else {
        return []
    }

    return content.segments.map { segment in
        switch segment.kind {
        case .markdown:
            return .markdown
        case .mermaid:
            return .mermaid
        }
    }
}
