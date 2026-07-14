// FILE: TurnMessageCaches.swift
// Purpose: Thread-safe caches for parsed markdown, file-change state, command status, diff chunks,
//   code comment directives, and file-change grouping.
// Layer: View Support
// Exports: MarkdownRenderableTextCache, FileChangeRenderState, MessageRowRenderModel,
//   CommandExecutionStatusCache, FileChangeSystemRenderCache, FileChangeBlockPresentation,
//   FileChangeBlockPresentationBuilder, PerFileDiffChunk, PerFileDiffParser, PerFileDiffChunkCache,
//   CodeCommentDirectiveContentCache, FileChangeGroupingCache
// Depends on: Foundation, CodexMessage, TurnMessageRegexCache, TurnFileChangeSummaryParser,
//   TurnDiffLineKind, MarkdownRenderProfile, TurnMermaidRenderer, CommandExecutionViews

import Foundation

/// Explicit cache flush hook for memory-pressure/manual recovery paths.
/// Normal thread switching should keep these hot caches warm.
enum TurnCacheManager {
    @MainActor static func resetAll() {
        MarkdownParseCacheReset.reset()
        MarkdownRenderableTextCache.reset()
        UserBubbleRenderModelCache.reset()
        UserBubbleCollapsedMarkdownPreview.reset()
        MessageRowRenderModelCache.reset()
        CommandExecutionStatusCache.reset()
        FileChangeSystemRenderCache.reset()
        FileChangeBlockPresentationCache.reset()
        PerFileDiffChunkCache.reset()
        CodeCommentDirectiveContentCache.reset()
        ThinkingDisclosureContentCache.reset()
        DiffBlockDetectionCache.reset()
        FileChangeGroupingCache.reset()
        UserBubbleInlineMarkdownRenderer.reset()
        MermaidMarkdownContentCache.reset()
        MermaidMarkdownContentCache.resetRenderedSnapshots()
    }
}

// Thread-safe bounded cache that evicts roughly half its entries when full instead of discarding everything.
final class BoundedCache<Key: Hashable, Value> {
    private let maxEntries: Int
    private let lock = NSLock()
    private var storage: [Key: Value] = [:]
    private var accessOrder: [Key] = []

    init(maxEntries: Int) {
        self.maxEntries = maxEntries
    }

    func get(_ key: Key) -> Value? {
        lock.lock()
        defer { lock.unlock() }
        guard let value = storage[key] else { return nil }
        markRecentlyUsed(key)
        return value
    }

    func set(_ key: Key, value: Value) {
        lock.lock()
        evictIfNeeded()
        storage[key] = value
        markRecentlyUsed(key)
        lock.unlock()
    }

    func getOrSet(_ key: Key, builder: () -> Value) -> Value {
        lock.lock()
        if let cached = storage[key] {
            markRecentlyUsed(key)
            lock.unlock()
            return cached
        }
        lock.unlock()

        let built = builder()

        lock.lock()
        evictIfNeeded()
        storage[key] = built
        markRecentlyUsed(key)
        lock.unlock()

        return built
    }

    func removeAll() {
        lock.lock()
        storage.removeAll(keepingCapacity: false)
        accessOrder.removeAll(keepingCapacity: false)
        lock.unlock()
    }

    private func evictIfNeeded() {
        guard storage.count >= maxEntries else { return }
        let evictCount = maxEntries / 2
        let keysToRemove = Array(accessOrder.prefix(evictCount))
        for key in keysToRemove {
            storage.removeValue(forKey: key)
        }
        accessOrder.removeFirst(min(evictCount, accessOrder.count))
    }

    private func markRecentlyUsed(_ key: Key) {
        accessOrder.removeAll { $0 == key }
        accessOrder.append(key)
        if accessOrder.count > maxEntries * 2 {
            accessOrder = accessOrder.filter { storage[$0] != nil }
        }
    }
}

enum TurnTextCacheKey {
    private static let sampleByteCount = 24
    private static let hexDigits = Array("0123456789abcdef")

    static func fingerprint(for text: String) -> String {
        let utf8 = text.utf8
        let byteCount = utf8.count
        let middleStart = max((byteCount / 2) - (sampleByteCount / 2), 0)
        let lastStart = max(byteCount - sampleByteCount, 0)

        return [
            String(byteCount),
            hexSample(in: utf8, startOffset: 0, length: sampleByteCount),
            hexSample(in: utf8, startOffset: middleStart, length: sampleByteCount),
            hexSample(in: utf8, startOffset: lastStart, length: sampleByteCount),
        ].joined(separator: "|")
    }

    static func key(messageID: String, kind: String, text: String) -> String {
        "\(messageID)|\(kind)|\(fingerprint(for: text))"
    }

    static func key(namespace: String, text: String) -> String {
        "\(namespace)|\(fingerprint(for: text))"
    }

    static func stableFingerprint(for text: String) -> String {
        let byteCount = text.utf8.count
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return "\(byteCount)|\(String(hash, radix: 16))"
    }

    static func stableKey(namespace: String, text: String) -> String {
        "\(namespace)|\(stableFingerprint(for: text))"
    }

    static func entriesFingerprint(_ entries: [TurnFileChangeSummaryEntry]) -> String {
        var hasher = Hasher()
        hasher.combine(entries.count)
        for entry in entries {
            hasher.combine(entry.path)
            hasher.combine(entry.action)
            hasher.combine(entry.additions)
            hasher.combine(entry.deletions)
        }
        return String(hasher.finalize())
    }

    private static func hexSample(
        in utf8: String.UTF8View,
        startOffset: Int,
        length: Int
    ) -> String {
        guard !utf8.isEmpty else { return "" }

        let clampedLength = min(length, utf8.count)
        let clampedStart = min(max(startOffset, 0), max(utf8.count - clampedLength, 0))
        let startIndex = utf8.index(utf8.startIndex, offsetBy: clampedStart)
        let endIndex = utf8.index(startIndex, offsetBy: clampedLength)

        var result = String()
        result.reserveCapacity(clampedLength * 2)

        for byte in utf8[startIndex..<endIndex] {
            result.append(hexDigits[Int(byte >> 4)])
            result.append(hexDigits[Int(byte & 0x0F)])
        }

        return result
    }
}

enum MarkdownRenderableTextCache {
    private static let cache = BoundedCache<String, String>(maxEntries: 512)

    static func rendered(
        raw: String,
        profile: MarkdownRenderProfile,
        builder: () -> String
    ) -> String {
        let key = TurnTextCacheKey.stableKey(namespace: profile.cacheKey, text: raw)
        return cache.getOrSet(key, builder: builder)
    }

    static func reset() {
        cache.removeAll()
    }
}
