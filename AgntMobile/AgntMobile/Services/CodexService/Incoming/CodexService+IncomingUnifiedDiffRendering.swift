// FILE: CodexService+IncomingUnifiedDiffRendering.swift
// Purpose: Renders unified diff payloads into file-change message bodies.
// Layer: Service
// Exports: CodexService incoming unified diff rendering helpers
// Depends on: Foundation

import Foundation

extension CodexService {
    func renderUnifiedDiffBody(_ diff: String, status: String) -> String {
        let perFileDiffs = splitUnifiedDiffByFile(diff)
        guard !perFileDiffs.isEmpty else {
            return "Status: \(status)\n\n`@agnt``diff\n\(diff)\n`@agnt``"
        }

        let renderedChanges = perFileDiffs.map { change in
            let normalizedPath = normalizeDiffPath(change.path)
            return "Path: \(normalizedPath)\nKind: update\n\n`@agnt``diff\n\(change.diff)\n`@agnt``"
        }

        return "Status: \(status)\n\n" + renderedChanges.joined(separator: "\n\n---\n\n")
    }

    private func splitUnifiedDiffByFile(_ diff: String) -> [(path: String, diff: String)] {
        let lines = diff.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard !lines.isEmpty else { return [] }

        var chunks: [(path: String, diff: String)] = []
        var currentLines: [String] = []
        var currentPath: String?

        func flushChunk() {
            guard !currentLines.isEmpty else { return }
            let fallbackPath = currentPath ?? parsePathFromDiffLines(currentLines) ?? "unknown"
            let chunkText = currentLines.joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !chunkText.isEmpty else {
                currentLines = []
                return
            }

            chunks.append((path: fallbackPath, diff: chunkText))
            currentLines = []
        }

        for line in lines {
            if line.hasPrefix("diff --git "), !currentLines.isEmpty {
                flushChunk()
                currentPath = nil
            }

            if currentPath == nil, let parsed = parsePathFromDiffLine(line) {
                currentPath = parsed
            }
            currentLines.append(line)
        }

        flushChunk()
        return chunks
    }

    private func parsePathFromDiffLines(_ lines: [String]) -> String? {
        for line in lines {
            if let parsed = parsePathFromDiffLine(line) {
                return parsed
            }
        }
        return nil
    }

    private func parsePathFromDiffLine(_ line: String) -> String? {
        if line.hasPrefix("+++ ") {
            let rawPath = String(line.dropFirst(4)).trimmingCharacters(in: .whitespacesAndNewlines)
            let normalized = normalizeDiffPath(rawPath)
            return normalized.isEmpty ? nil : normalized
        }

        if line.hasPrefix("diff --git ") {
            let components = line.split(separator: " ", omittingEmptySubsequences: true)
            if components.count >= 4 {
                let normalized = normalizeDiffPath(String(components[3]))
                return normalized.isEmpty ? nil : normalized
            }
        }

        return nil
    }

    private func normalizeDiffPath(_ rawValue: String) -> String {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != "/dev/null" else { return "unknown" }

        if trimmed.hasPrefix("a/") || trimmed.hasPrefix("b/") {
            return String(trimmed.dropFirst(2))
        }
        return trimmed
    }
}
