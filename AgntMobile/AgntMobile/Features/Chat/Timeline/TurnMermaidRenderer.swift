// FILE: TurnMermaidRenderer.swift
// Purpose: Detects fenced Mermaid blocks and converts them into cached static snapshots for smooth timeline scrolling.
// Layer: View Support
// Exports: MermaidMarkdownContent, MermaidMarkdownSegment, MermaidMarkdownContentCache, MermaidMarkdownContentView
// Depends on: SwiftUI, WebKit, MarkdownTextView

import Foundation
import SwiftUI

struct MermaidMarkdownContent {
    let segments: [MermaidMarkdownSegment]

    var hasMermaidBlocks: Bool {
        segments.contains { $0.kind.isMermaid }
    }
}

struct MermaidMarkdownSegment: Identifiable {
    enum Kind {
        case markdown(String)
        case mermaid(String)

        var isMermaid: Bool {
            if case .mermaid = self {
                return true
            }
            return false
        }
    }

    let id: String
    let kind: Kind
}

enum MermaidMarkdownContentCache {
    static let cache = BoundedCache<String, MermaidMarkdownContent?>(maxEntries: 256)

    // Parses Mermaid fences once per message snapshot so the timeline does not redo regex work while scrolling.
    static func content(messageID: String, text: String) -> MermaidMarkdownContent? {
        let cacheKey = "\(messageID)|mermaid-markdown|\(TurnTextCacheKey.stableFingerprint(for: text))"
        return cache.getOrSet(cacheKey) {
            MermaidMarkdownParser.parse(text)
        }
    }

    static func reset() {
        cache.removeAll()
    }

    static func resetRenderedSnapshots() {
        MermaidRenderedSnapshotCache.reset()
    }
}

struct MermaidMarkdownContentView: View {
    let content: MermaidMarkdownContent

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(content.segments) { segment in
                switch segment.kind {
                case .markdown(let markdown):
                    MarkdownTextView(
                        text: markdown,
                        profile: .assistantProse,
                        enablesSelection: enablesInlineMarkdownSelectionInTimeline,
                        constrainsToAvailableWidth: true
                    )
                case .mermaid(let source):
                    MermaidBlockView(source: source)
                }
            }
        }
    }
}
