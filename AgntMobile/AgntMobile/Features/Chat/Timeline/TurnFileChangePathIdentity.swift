// FILE: TurnFileChangePathIdentity.swift
// Purpose: Normalizes file-change paths when grouping repeated snapshots.
// Layer: View Support
// Exports: FileChangePathIdentity
// Depends on: Foundation

import Foundation

enum FileChangePathIdentity {
    // Treats absolute-vs-relative references to the same repo file as one identity,
    // while keeping same-named files in different directories separate.
    static func representsSameFile(_ lhs: String, _ rhs: String) -> Bool {
        let normalizedLHS = normalizedPath(lhs)
        let normalizedRHS = normalizedPath(rhs)

        guard !normalizedLHS.isEmpty, !normalizedRHS.isEmpty else {
            return false
        }
        if normalizedLHS == normalizedRHS {
            return true
        }

        let lhsIsAbsolute = isAbsolutePath(lhs)
        let rhsIsAbsolute = isAbsolutePath(rhs)
        guard lhsIsAbsolute != rhsIsAbsolute else {
            return false
        }

        let absolutePath = lhsIsAbsolute ? normalizedLHS : normalizedRHS
        let relativePath = lhsIsAbsolute ? normalizedRHS : normalizedLHS
        guard relativePath.contains("/") else {
            return false
        }

        return absolutePath.hasSuffix("/" + relativePath)
    }

    static func preferredDisplayPath(_ lhs: String, _ rhs: String) -> String {
        let trimmedLHS = lhs.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedRHS = rhs.trimmingCharacters(in: .whitespacesAndNewlines)

        if trimmedLHS.isEmpty { return trimmedRHS }
        if trimmedRHS.isEmpty { return trimmedLHS }
        if trimmedLHS == trimmedRHS { return trimmedLHS }
        if representsSameFile(trimmedLHS, trimmedRHS) {
            return trimmedLHS.count <= trimmedRHS.count ? trimmedLHS : trimmedRHS
        }
        return trimmedLHS
    }

    static func normalizedPath(_ rawPath: String) -> String {
        var normalized = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.hasPrefix("a/") || normalized.hasPrefix("b/") {
            normalized = String(normalized.dropFirst(2))
        }
        if normalized.hasPrefix("./") {
            normalized = String(normalized.dropFirst(2))
        }
        if let range = normalized.range(of: #":\d+(?::\d+)?$"#, options: .regularExpression) {
            normalized.removeSubrange(range)
        }
        return normalized.lowercased()
    }

    private static func isAbsolutePath(_ rawPath: String) -> Bool {
        rawPath.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/")
    }
}
