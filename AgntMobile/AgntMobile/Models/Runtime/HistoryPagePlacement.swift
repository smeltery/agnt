import Foundation

// A provider cursor anchors an older page inside the cached timeline. Preserve
// that boundary when cached phone turns extend beyond the fetched history window.
enum HistoryPagePlacement {
    nonisolated static func position(
        page: [CodexMessage], existing: [CodexMessage], cursor: JSONValue
    ) -> (existing: [CodexMessage], page: [CodexMessage])? {
        let prefix = "agnt-opencode-turn:desc:"
        guard case .string(let raw) = cursor, raw.hasPrefix(prefix), !page.isEmpty,
              let boundary = String(raw.dropFirst(prefix.count)).removingPercentEncoding,
              let order = existing.filter({ $0.turnId == boundary }).map(\.orderIndex).min(),
              order <= Int.max - page.count else { return nil }
        var shifted = existing
        guard !shifted.contains(where: { $0.orderIndex > Int.max - page.count }) else { return nil }
        for index in shifted.indices where shifted[index].orderIndex >= order {
            shifted[index].orderIndex += page.count
        }
        var positioned = page
        for index in positioned.indices { positioned[index].orderIndex = order + index }
        return (shifted, positioned)
    }
}
