// FILE: CodexService+RuntimeDebug.swift
// Purpose: Runtime debug logging and compact item-completion batching.
// Layer: Service
// Exports: CodexService runtime debug helpers
// Depends on: CodexService runtime debug state

import Foundation

private let runtimeDebugTimestampFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "HH:mm:ss.SSS"
    return formatter
}()

private enum RuntimeDebugLogPolicy {
    static let maximumStoredEntries = 400
    static let storedEntryTrimBatch = 80
    static let itemCompletionBatchSize = 100
    static let itemCompletionFlushNanoseconds: UInt64 = 2_000_000_000
    static let maximumReportedItemTypes = 6
}

extension CodexService {
    func debugRuntimeLog(_ message: String) {
        let entry = "[\(runtimeDebugTimestampFormatter.string(from: Date()))] \(message)"
        runtimeDebugLogEntries.append(entry)
        if runtimeDebugLogEntries.count > RuntimeDebugLogPolicy.maximumStoredEntries {
            runtimeDebugLogEntries.removeFirst(RuntimeDebugLogPolicy.storedEntryTrimBatch)
        }
#if DEBUG
        print("[CodexRuntime] \(entry)")
#endif
    }

    func recordCompactRuntimeItemCompletion(itemType: String) {
        let normalizedType = itemType.trimmingCharacters(in: .whitespacesAndNewlines)
        compactRuntimeItemCompletedCount += 1
        compactRuntimeItemCompletedTypes[normalizedType.isEmpty ? "unknown" : normalizedType, default: 0] += 1

        if compactRuntimeItemCompletedCount >= RuntimeDebugLogPolicy.itemCompletionBatchSize {
            flushCompactRuntimeItemCompletions()
            return
        }

        guard compactRuntimeItemCompletedFlushTask == nil else {
            return
        }

        compactRuntimeItemCompletedFlushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: RuntimeDebugLogPolicy.itemCompletionFlushNanoseconds)
            guard !Task.isCancelled else { return }
            self?.flushCompactRuntimeItemCompletions()
        }
    }

    func flushCompactRuntimeItemCompletions() {
        compactRuntimeItemCompletedFlushTask?.cancel()
        compactRuntimeItemCompletedFlushTask = nil

        let total = compactRuntimeItemCompletedCount
        let typeCounts = compactRuntimeItemCompletedTypes
        compactRuntimeItemCompletedCount = 0
        compactRuntimeItemCompletedTypes.removeAll(keepingCapacity: true)

        guard total > 0 else {
            return
        }

        let sortedTypes = typeCounts.sorted { lhs, rhs in
            lhs.value == rhs.value ? lhs.key < rhs.key : lhs.value > rhs.value
        }
        let reportedTypes = sortedTypes.prefix(RuntimeDebugLogPolicy.maximumReportedItemTypes)
        var typeSummary = reportedTypes.map { "\($0.key):\($0.value)" }
        let reportedCount = reportedTypes.reduce(into: 0) { partialResult, entry in
            partialResult += entry.value
        }
        if reportedCount < total {
            typeSummary.append("other:\(total - reportedCount)")
        }

        debugRuntimeLog("rpc item/completed x\(total) types=\(typeSummary.joined(separator: ","))")
    }

    func clearRuntimeDebugLog() {
        compactRuntimeItemCompletedFlushTask?.cancel()
        compactRuntimeItemCompletedFlushTask = nil
        compactRuntimeItemCompletedCount = 0
        compactRuntimeItemCompletedTypes.removeAll(keepingCapacity: true)
        runtimeDebugLogEntries.removeAll()
    }
}
