// FILE: AIUnifiedPatchParser.swift
// Purpose: Parses unified patches into assistant change-set summaries.
// Layer: Model
// Exports: AIUnifiedPatchAnalysis, AIUnifiedPatchParser
// Depends on: Foundation, CryptoKit, AIChangeSetModels

import Foundation
import CryptoKit

struct AIUnifiedPatchAnalysis: Hashable, Sendable {
    let fileChanges: [AIFileChange]
    let unsupportedReasons: [String]

    var affectedFiles: [String] {
        fileChanges.map(\.path)
    }

    var totalAdditions: Int {
        fileChanges.reduce(0) { $0 + $1.additions }
    }

    var totalDeletions: Int {
        fileChanges.reduce(0) { $0 + $1.deletions }
    }
}

enum AIUnifiedPatchParser {
    // Parses a unified patch into per-file summaries and flags unsupported metadata-only changes.
    static func analyze(_ rawPatch: String) -> AIUnifiedPatchAnalysis {
        let patch = rawPatch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !patch.isEmpty else {
            return AIUnifiedPatchAnalysis(fileChanges: [], unsupportedReasons: ["No exact patch was captured."])
        }

        let chunks = splitIntoChunks(patch)
        guard !chunks.isEmpty else {
            return AIUnifiedPatchAnalysis(fileChanges: [], unsupportedReasons: ["No exact patch was captured."])
        }

        var fileChanges: [AIFileChange] = []
        var unsupportedReasons: Set<String> = []

        for chunk in chunks {
            let analysis = analyzeChunk(chunk)
            if let fileChange = analysis.fileChange {
                fileChanges.append(fileChange)
            }
            unsupportedReasons.formUnion(analysis.unsupportedReasons)
        }

        if fileChanges.isEmpty {
            unsupportedReasons.insert("This response cannot be auto-reverted because no exact patch was captured.")
        }

        return AIUnifiedPatchAnalysis(
            fileChanges: fileChanges,
            unsupportedReasons: Array(unsupportedReasons).sorted()
        )
    }

    static func hash(for rawPatch: String) -> String {
        let digest = SHA256.hash(data: Data(rawPatch.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func splitIntoChunks(_ patch: String) -> [[String]] {
        let lines = patch.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard !lines.isEmpty else { return [] }

        var chunks: [[String]] = []
        var current: [String] = []

        func flushCurrent() {
            guard !current.isEmpty else { return }
            chunks.append(current)
            current = []
        }

        for line in lines {
            if line.hasPrefix("diff --git "), !current.isEmpty {
                flushCurrent()
            }
            current.append(line)
        }

        flushCurrent()
        return chunks
    }

    private static func analyzeChunk(_ lines: [String]) -> (fileChange: AIFileChange?, unsupportedReasons: Set<String>) {
        guard !lines.isEmpty else {
            return (nil, [])
        }

        let path = extractPath(from: lines)
        let isBinary = lines.contains { $0.hasPrefix("Binary files ") || $0 == "GIT binary patch" }
        let isRenameOrModeOnly = lines.contains {
            $0.hasPrefix("rename from ")
                || $0.hasPrefix("rename to ")
                || $0.hasPrefix("copy from ")
                || $0.hasPrefix("copy to ")
                || $0.hasPrefix("old mode ")
                || $0.hasPrefix("new mode ")
                || $0.hasPrefix("new file mode 120")
                || $0.hasPrefix("deleted file mode 120")
                || $0.hasPrefix("similarity index ")
        }

        let isCreate = lines.contains("new file mode 100644")
            || lines.contains("new file mode 100755")
            || lines.contains("--- /dev/null")
        let isDelete = lines.contains("deleted file mode 100644")
            || lines.contains("deleted file mode 100755")
            || lines.contains("+++ /dev/null")

        var additions = 0
        var deletions = 0
        for line in lines {
            guard let first = line.first else { continue }
            if first == "+", !line.hasPrefix("+++") {
                additions += 1
            } else if first == "-", !line.hasPrefix("---") {
                deletions += 1
            }
        }

        var unsupportedReasons: Set<String> = []
        if isBinary {
            unsupportedReasons.insert("Binary changes are not auto-revertable in v1.")
        }
        if isRenameOrModeOnly {
            unsupportedReasons.insert("Rename, mode-only, or symlink changes are not auto-revertable in v1.")
        }

        let kind: AIFileChangeKind = isCreate ? .create : (isDelete ? .delete : .update)
        let hasPatchBody = additions > 0 || deletions > 0 || isCreate || isDelete
        guard !path.isEmpty, hasPatchBody else {
            if !isBinary && !isRenameOrModeOnly {
                unsupportedReasons.insert("This response cannot be auto-reverted because no exact patch was captured.")
            }
            return (nil, unsupportedReasons)
        }

        return (
            AIFileChange(
                path: path,
                kind: kind,
                additions: additions,
                deletions: deletions,
                isBinary: isBinary,
                isRenameOrModeOnly: isRenameOrModeOnly,
                beforeContentHash: nil,
                afterContentHash: nil
            ),
            unsupportedReasons
        )
    }

    private static func extractPath(from lines: [String]) -> String {
        for line in lines {
            if line.hasPrefix("+++ ") {
                let rawPath = String(line.dropFirst(4)).trimmingCharacters(in: .whitespacesAndNewlines)
                let normalized = normalizeDiffPath(rawPath)
                if !normalized.isEmpty, normalized != "/dev/null" {
                    return normalized
                }
            }
        }

        for line in lines {
            if line.hasPrefix("diff --git ") {
                let components = line.split(separator: " ", omittingEmptySubsequences: true)
                if components.count >= 4 {
                    let normalized = normalizeDiffPath(String(components[3]))
                    if !normalized.isEmpty {
                        return normalized
                    }
                }
            }
        }

        return ""
    }

    private static func normalizeDiffPath(_ rawPath: String) -> String {
        var value = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("a/") || value.hasPrefix("b/") {
            value = String(value.dropFirst(2))
        }
        return value
    }
}
