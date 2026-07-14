// FILE: TurnContentDirectiveCaches.swift
// Purpose: Code-comment, thinking, diff-block, and file-change grouping caches.
// Layer: View Support

import Foundation
// ─── Code Comment Directive Content Cache ───────────────────────────

enum CodeCommentDirectiveContentCache {
    private static let cache = BoundedCache<String, CodeCommentDirectiveContent>(maxEntries: 256)

    static func reset() { cache.removeAll() }

    static func content(messageID: String, text: String) -> CodeCommentDirectiveContent {
        cache.getOrSet(TurnTextCacheKey.key(messageID: messageID, kind: "code-comment", text: text)) {
            CodeCommentDirectiveParser.parse(from: text)
        }
    }
}

// ─── Thinking Disclosure Content Cache ──────────────────────────────

enum ThinkingDisclosureContentCache {
    private static let cache = BoundedCache<String, ThinkingDisclosureContent>(maxEntries: 256)

    static func reset() { cache.removeAll() }

    static func content(messageID: String, text: String) -> ThinkingDisclosureContent {
        cache.getOrSet(TurnTextCacheKey.key(messageID: messageID, kind: "thinking", text: text)) {
            ThinkingDisclosureParser.parse(from: text)
        }
    }
}

// ─── Diff Block Detection Cache ─────────────────────────────────────

enum DiffBlockDetectionCache {
    private static let cache = BoundedCache<String, Bool>(maxEntries: 512)

    static func reset() { cache.removeAll() }

    static func isDiffBlock(code: String, profile: MarkdownRenderProfile) -> Bool {
        switch profile {
        case .assistantProse, .userProse, .fileChangeSystem:
            break
        }

        let key = TurnTextCacheKey.key(namespace: "\(profile.cacheKey)|diff-block", text: code)
        return cache.getOrSet(key) {
            TurnDiffLineKind.detectVerifiedPatch(in: code)
        }
    }
}

// ─── File Change Grouping Cache ─────────────────────────────────────

struct FileChangeGroup: Identifiable {
    let key: String
    let entries: [TurnFileChangeSummaryEntry]
    var id: String { key }
}

enum FileChangeGroupingCache {
    private static let cache = BoundedCache<String, [FileChangeGroup]>(maxEntries: 256)

    static func reset() { cache.removeAll() }

    static func grouped(messageID: String, entries: [TurnFileChangeSummaryEntry]) -> [FileChangeGroup] {
        var hasher = Hasher()
        hasher.combine(messageID)
        for entry in entries {
            hasher.combine(entry.path)
            hasher.combine(entry.action)
            hasher.combine(entry.additions)
            hasher.combine(entry.deletions)
        }
        let key = "\(hasher.finalize())"

        return cache.getOrSet(key) {
            var order: [String] = []
            var dict: [String: [TurnFileChangeSummaryEntry]] = [:]
            for entry in entries {
                let groupKey = entry.action?.rawValue ?? "Edited"
                if dict[groupKey] == nil { order.append(groupKey) }
                dict[groupKey, default: []].append(entry)
            }
            return order.map { FileChangeGroup(key: $0, entries: dict[$0]!) }
        }
    }
}
