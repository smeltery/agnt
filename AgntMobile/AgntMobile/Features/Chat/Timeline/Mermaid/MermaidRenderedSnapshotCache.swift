// FILE: MermaidRenderedSnapshotCache.swift
// Purpose: Rendered Mermaid snapshot descriptors, image cache, height cache, and bundled asset lookup.
// Layer: View Support

import Foundation
import UIKit

struct MermaidRenderDescriptor: Hashable {
    let cacheKey: String
    let isDarkMode: Bool
    let targetWidth: CGFloat

    init(source: String, isDarkMode: Bool, targetWidth: CGFloat) {
        let roundedWidth = max(1, Int(targetWidth.rounded(.toNearestOrEven)))
        self.isDarkMode = isDarkMode
        self.targetWidth = CGFloat(roundedWidth)
        self.cacheKey = "\(isDarkMode ? "dark" : "light")|\(roundedWidth)|\(TurnTextCacheKey.stableFingerprint(for: source))"
    }
}

struct MermaidRenderedSnapshot {
    let image: UIImage
    let height: CGFloat
}

final class MermaidRenderedSnapshotBox: NSObject {
    let snapshot: MermaidRenderedSnapshot

    init(snapshot: MermaidRenderedSnapshot) {
        self.snapshot = snapshot
    }
}

enum MermaidRenderedSnapshotCache {
    static let snapshotCache: NSCache<NSString, MermaidRenderedSnapshotBox> = {
        let cache = NSCache<NSString, MermaidRenderedSnapshotBox>()
        cache.countLimit = 96
        return cache
    }()
    static let lock = NSLock()
    static var knownHeightsByKey: [String: CGFloat] = [:]
    static var knownHeightAccessOrder: [String] = []

    static func snapshot(for descriptor: MermaidRenderDescriptor) -> MermaidRenderedSnapshot? {
        snapshotCache.object(forKey: descriptor.cacheKey as NSString)?.snapshot
    }

    static func knownHeight(for descriptor: MermaidRenderDescriptor) -> CGFloat? {
        lock.lock()
        let height = knownHeightsByKey[descriptor.cacheKey]
        if height != nil {
            markKnownHeightRecentlyUsed(descriptor.cacheKey)
        }
        lock.unlock()
        return height
    }

    static func store(_ snapshot: MermaidRenderedSnapshot, for descriptor: MermaidRenderDescriptor) {
        snapshotCache.setObject(MermaidRenderedSnapshotBox(snapshot: snapshot), forKey: descriptor.cacheKey as NSString)
        storeKnownHeight(snapshot.height, for: descriptor)
    }

    static func storeKnownHeight(_ height: CGFloat, for descriptor: MermaidRenderDescriptor) {
        lock.lock()
        if knownHeightsByKey.count >= 256 {
            evictKnownHeights()
        }
        knownHeightsByKey[descriptor.cacheKey] = height
        markKnownHeightRecentlyUsed(descriptor.cacheKey)
        lock.unlock()
    }

    static func reset() {
        snapshotCache.removeAllObjects()
        lock.lock()
        knownHeightsByKey.removeAll(keepingCapacity: false)
        knownHeightAccessOrder.removeAll(keepingCapacity: false)
        lock.unlock()
    }

    private static func evictKnownHeights() {
        let keysToRemove = Array(knownHeightAccessOrder.prefix(128))
        for key in keysToRemove {
            knownHeightsByKey.removeValue(forKey: key)
        }
        knownHeightAccessOrder.removeFirst(min(keysToRemove.count, knownHeightAccessOrder.count))
    }

    private static func markKnownHeightRecentlyUsed(_ key: String) {
        knownHeightAccessOrder.removeAll { $0 == key }
        knownHeightAccessOrder.append(key)
    }
}

enum MermaidBundledAsset {
    static func scriptURL() -> URL? {
        if let url = Bundle.main.url(
            forResource: "mermaid.min",
            withExtension: "js",
            subdirectory: "Resources/Mermaid"
        ) {
            return url
        }

        if let url = Bundle.main.url(forResource: "mermaid.min", withExtension: "js") {
            return url
        }

        return Bundle.main.urls(forResourcesWithExtension: "js", subdirectory: nil)?
            .first(where: { $0.lastPathComponent == "mermaid.min.js" })
    }
}

