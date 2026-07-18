// FILE: CodexService+MessageSystemRowIdentity.swift
// Purpose: File-change path identity, snapshot detection, and duplicate system-row pruning.
// Layer: Service

import Foundation

extension CodexService {
    func normalizedFileChangePathKeys(from text: String) -> Set<String> {
        let inlineTotalsRegex = try? NSRegularExpression(
            pattern: #"\s*[+\u{FF0B}]\s*\d+\s*[-\u{2212}\u{2013}\u{2014}\u{FE63}\u{FF0D}]\s*\d+\s*$"#
        )
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var keys: Set<String> = []

        for line in lines {
            var trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("• ") {
                trimmed = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespacesAndNewlines)
            }

            if trimmed.lowercased().hasPrefix("path:") {
                let rawPath = trimmed.dropFirst("Path:".count).trimmingCharacters(in: .whitespacesAndNewlines)
                keys.formUnion(normalizedFileChangePathAliases(from: rawPath))
                continue
            }

            if trimmed.hasPrefix("+++ ") || trimmed.hasPrefix("--- ") {
                let rawPath = String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespacesAndNewlines)
                keys.formUnion(normalizedFileChangePathAliases(from: rawPath))
                continue
            }

            if trimmed.hasPrefix("diff --git ") {
                let components = trimmed.split(separator: " ", omittingEmptySubsequences: true)
                if components.count >= 4 {
                    keys.formUnion(normalizedFileChangePathAliases(from: String(components[3])))
                }
                continue
            }

            let lowercased = trimmed.lowercased()
            let actionVerbs = [
                "edited ",
                "updated ",
                "added ",
                "created ",
                "deleted ",
                "removed ",
                "renamed ",
                "moved ",
            ]
            if let verb = actionVerbs.first(where: { lowercased.hasPrefix($0) }) {
                var rawPath = String(trimmed.dropFirst(verb.count))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if let inlineTotalsRegex {
                    let range = NSRange(location: 0, length: (rawPath as NSString).length)
                    rawPath = inlineTotalsRegex.stringByReplacingMatches(
                        in: rawPath,
                        range: range,
                        withTemplate: ""
                    ).trimmingCharacters(in: .whitespacesAndNewlines)
                }
                keys.formUnion(normalizedFileChangePathAliases(from: rawPath))
            }
        }

        return keys
    }

    private func normalizedFileChangePathAliases(from rawPath: String) -> Set<String> {
        guard let normalized = normalizeFileChangePathKey(rawPath) else {
            return Set<String>()
        }

        var aliases: Set<String> = [normalized]
        let components = normalized.split(separator: "/", omittingEmptySubsequences: true)
        if let workspaceIndex = components.firstIndex(where: { $0 == "workspace" }),
           components.count > workspaceIndex + 2 {
            let relative = components[(workspaceIndex + 2)...].joined(separator: "/")
            if !relative.isEmpty {
                aliases.insert(relative)
            }
        }
        return aliases
    }

    private func normalizeFileChangePathKey(_ rawPath: String) -> String? {
        var normalized = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.isEmpty { return nil }
        if normalized == "/dev/null" { return nil }

        normalized = normalized.replacingOccurrences(of: "`", with: "")
        normalized = normalized.replacingOccurrences(of: "\"", with: "")
        normalized = normalized.replacingOccurrences(of: "'", with: "")
        if normalized.hasPrefix("("), normalized.hasSuffix(")"), normalized.count > 2 {
            normalized = String(normalized.dropFirst().dropLast())
        }

        if normalized.hasPrefix("a/") || normalized.hasPrefix("b/") {
            normalized = String(normalized.dropFirst(2))
        }
        if normalized.hasPrefix("./") {
            normalized = String(normalized.dropFirst(2))
        }
        if let range = normalized.range(
            of: #":\d+(?::\d+)?$"#,
            options: .regularExpression
        ) {
            normalized.removeSubrange(range)
        }

        while let last = normalized.last, ",.;".contains(last) {
            normalized.removeLast()
        }

        normalized = normalized.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return nil }
        return normalized.lowercased()
    }

    func isFileChangeSnapshotPayload(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        let lowered = trimmed.lowercased()
        if lowered.hasPrefix("status:") {
            return true
        }

        let lines = trimmed.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var hasPath = false
        var hasKind = false
        var hasTotals = false
        var hasDiffFence = false
        var hasDiffHeader = false

        for line in lines {
            let candidate = line.trimmingCharacters(in: .whitespacesAndNewlines)
            let lower = candidate.lowercased()
            if lower.hasPrefix("path:") { hasPath = true }
            if lower.hasPrefix("kind:") { hasKind = true }
            if lower.hasPrefix("totals:") { hasTotals = true }
            if candidate.hasPrefix("`@agnt``diff") || candidate == "`@agnt``" { hasDiffFence = true }
            if candidate.hasPrefix("diff --git ")
                || candidate.hasPrefix("+++ ")
                || candidate.hasPrefix("--- ")
                || candidate.hasPrefix("@@ ") {
                hasDiffHeader = true
            }
        }

        if hasPath && hasKind {
            return true
        }
        if hasPath && (hasTotals || hasDiffFence || hasDiffHeader) {
            return true
        }
        if hasDiffFence && hasDiffHeader {
            return true
        }

        return false
    }

    // Coalesces generic tool activity lines so the timeline keeps one stable row per tool item.
    func mergeToolActivityText(existing: String, incoming: String, isStreaming: Bool) -> String {
        let existingTrimmed = existing.trimmingCharacters(in: .whitespacesAndNewlines)
        let incomingTrimmed = incoming.trimmingCharacters(in: .whitespacesAndNewlines)

        if incomingTrimmed.isEmpty {
            return existingTrimmed
        }
        if existingTrimmed.isEmpty || isStreamingPlaceholder(existingTrimmed, for: .toolActivity) {
            return incomingTrimmed
        }
        if isStreamingPlaceholder(incomingTrimmed, for: .toolActivity) {
            return existingTrimmed
        }

        let incomingLines = incomingTrimmed
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !incomingLines.isEmpty else {
            return existingTrimmed
        }

        var mergedLines = existingTrimmed
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        for line in incomingLines where !mergedLines.contains(where: {
            $0.caseInsensitiveCompare(line) == .orderedSame
        }) {
            if !isStreaming,
               let existingIndex = mergedLines.firstIndex(where: { candidate in
                   let existingTokens = candidate.split(whereSeparator: \.isWhitespace)
                   let incomingTokens = line.split(whereSeparator: \.isWhitespace)
                   guard existingTokens.count >= 2, incomingTokens.count >= 2 else {
                       return false
                   }
                   return existingTokens.dropFirst().joined(separator: " ")
                       .caseInsensitiveCompare(incomingTokens.dropFirst().joined(separator: " ")) == .orderedSame
               }) {
                mergedLines[existingIndex] = line
            } else {
                mergedLines.append(line)
            }
        }

        return mergedLines.isEmpty ? incomingTrimmed : mergedLines.joined(separator: "\n")
    }

    func uniqueFileChangeMessageIDForTurn(
        threadId: String,
        turnId: String,
        allowsTurnlessFallback: Bool = false
    ) -> String? {
        let candidates = (messagesByThread[threadId] ?? []).filter { candidate in
            candidate.role == .system
                && candidate.kind == .fileChange
                && (
                    candidate.turnId == turnId
                        || (allowsTurnlessFallback
                            && candidate.turnId == nil
                            && turnlessFileChangeRowBelongsToTurn(candidate, threadId: threadId, turnId: turnId))
                )
        }
        guard candidates.count == 1 else {
            return nil
        }
        return candidates[0].id
    }

    func turnlessFileChangeRowBelongsToTurn(
        _ candidate: CodexMessage,
        threadId: String,
        turnId: String
    ) -> Bool {
        guard let messages = messagesByThread[threadId],
              let candidateIndex = messages.firstIndex(where: { $0.id == candidate.id }) else {
            return false
        }
        return Self.turnlessFileChangeRowIsClaimable(
            in: messages,
            candidateIndex: candidateIndex,
            turnId: turnId,
            turnBlockRange: Self.contiguousTurnBlockRange(in: messages, turnId: turnId)
        )
    }

    func pruneDuplicateSystemRows(
        in threadMessages: inout [CodexMessage],
        keepIndex: Int,
        kind: CodexMessageKind,
        turnId: String,
        fileChangePathKeys: Set<String> = Set<String>(),
        isAuthoritativeFileChangeSnapshot: Bool = false,
        commandKey: String? = nil,
        toolActivityKey: String? = nil
    ) {
        guard threadMessages.indices.contains(keepIndex) else { return }
        let keepID = threadMessages[keepIndex].id
        let keepText = threadMessages[keepIndex].text.trimmingCharacters(in: .whitespacesAndNewlines)
        let turnBlockRange = Self.contiguousTurnBlockRange(in: threadMessages, turnId: turnId)
        let prunableTurnlessIDs = Set(threadMessages.indices.compactMap { index -> String? in
            guard let turnBlockRange,
                  turnBlockRange.contains(index),
                  threadMessages[index].turnId == nil else {
                return nil
            }
            return threadMessages[index].id
        })

        threadMessages.removeAll { candidate in
            guard candidate.id != keepID,
                  candidate.role == .system,
                  candidate.kind == kind else {
                return false
            }

            if kind == .fileChange {
                let sameTurn = candidate.turnId == turnId
                let canPruneTurnlessFallback = isAuthoritativeFileChangeSnapshot
                    && candidate.turnId == nil
                    && prunableTurnlessIDs.contains(candidate.id)
                guard sameTurn || canPruneTurnlessFallback else {
                    return false
                }

                if !fileChangePathKeys.isEmpty {
                    let candidateKeys = normalizedFileChangePathKeys(from: candidate.text)
                    if isAuthoritativeFileChangeSnapshot {
                        return candidateKeys.isSubset(of: fileChangePathKeys)
                    }
                    return !candidateKeys.isDisjoint(with: fileChangePathKeys)
                }
                return candidate.text.trimmingCharacters(in: .whitespacesAndNewlines) == keepText
            }

            guard candidate.turnId == turnId else {
                return false
            }

            if kind == .commandExecution, let commandKey {
                return commandExecutionPreviewKey(from: candidate.text) == commandKey
            }

            if kind == .toolActivity, let toolActivityKey {
                return toolActivityPreviewKey(from: candidate.text) == toolActivityKey
            }

            return false
        }
    }

}
