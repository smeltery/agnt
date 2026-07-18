// FILE: CodexService+IncomingFileChanges.swift
// Purpose: Decodes incoming file-change, diff, and patch-like tool-call payloads.
// Layer: Service
// Exports: CodexService incoming file-change decoders
// Depends on: Foundation, JSONValue

import Foundation

extension CodexService {
    func decodeFileChangeItemBody(_ itemObject: IncomingParamsObject) -> String {
        let status = itemObject["status"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedStatus = (status?.isEmpty == false) ? status! : "inProgress"
        var sections: [String] = ["Status: \(normalizedStatus)"]

        let changes = decodeFileChangeEntries(from: itemObject["changes"])
        let renderedChanges = changes.map { entry -> String in
            var chunk = "Path: \(entry.path)\nKind: \(entry.kind)"
            if let totals = entry.inlineTotals {
                chunk += "\nTotals: +\(totals.additions) -\(totals.deletions)"
            }
            if !entry.diff.isEmpty {
                chunk += "\n\n`@agnt``diff\n\(entry.diff)\n`@agnt``"
            }
            return chunk
        }

        if !renderedChanges.isEmpty {
            sections.append(renderedChanges.joined(separator: "\n\n---\n\n"))
        }

        return sections.joined(separator: "\n\n")
    }

    // Extracts a single canonical patch for revert tracking; turn/diff remains the authoritative source.
    func extractChangeSetUnifiedPatch(
        from itemObject: IncomingParamsObject,
        itemType: String
    ) -> String? {
        switch itemType {
        case "diff":
            if let diff = extractToolCallUnifiedDiff(from: itemObject), looksLikePatchText(diff) {
                return normalizedUnifiedPatchPayload(diff)
            }
        case "toolcall":
            if let diff = extractToolCallUnifiedDiff(from: itemObject), looksLikePatchText(diff) {
                return normalizedUnifiedPatchPayload(diff)
            }
            fallthrough
        case "filechange":
            let changes = decodeFileChangeEntries(from: itemObject["changes"])
            if !changes.isEmpty {
                let joinedDiff = changes
                    .map(\.diff)
                    .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                    .joined(separator: "\n")
                if let normalizedPatch = normalizedUnifiedPatchPayload(joinedDiff) {
                    return normalizedPatch
                }
            }
            let diff = decodeChangeDiff(from: itemObject)
            if let normalizedPatch = normalizedUnifiedPatchPayload(diff) {
                return normalizedPatch
            }
        default:
            break
        }

        return nil
    }

    func decodeToolCallFileChangeBody(
        _ itemObject: IncomingParamsObject,
        isCompleted: Bool
    ) -> String? {
        guard isLikelyFileChangeToolCall(itemObject: itemObject, fallbackText: extractToolCallOutputText(from: itemObject)) else {
            return nil
        }

        let status = normalizedFileChangeStatus(from: itemObject, isCompleted: isCompleted)
        var synthetic = itemObject
        if synthetic["status"] == nil {
            synthetic["status"] = .string(status)
        }
        if synthetic["changes"] == nil, let extractedChanges = extractToolCallChanges(from: itemObject) {
            synthetic["changes"] = extractedChanges
        }

        let changes = decodeFileChangeEntries(from: synthetic["changes"])
        if !changes.isEmpty {
            return decodeFileChangeItemBody(synthetic)
        }

        if let diff = extractToolCallUnifiedDiff(from: itemObject), looksLikePatchText(diff) {
            return renderUnifiedDiffBody(diff, status: status)
        }

        if let output = extractToolCallOutputText(from: itemObject),
           !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Status: \(status)\n\n" + output.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        return nil
    }

    func decodeDiffItemBody(
        _ itemObject: IncomingParamsObject,
        isCompleted: Bool
    ) -> String? {
        let status = normalizedFileChangeStatus(from: itemObject, isCompleted: isCompleted)
        if let diff = extractToolCallUnifiedDiff(from: itemObject), looksLikePatchText(diff) {
            return renderUnifiedDiffBody(diff, status: status)
        }

        if let output = extractToolCallOutputText(from: itemObject),
           !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Status: \(status)\n\n" + output.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        return nil
    }

    func extractToolCallOutputText(from itemObject: IncomingParamsObject) -> String? {
        if let directOutput = itemObject["output"]?.stringValue,
           !directOutput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return directOutput.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let directResult = itemObject["result"]?.stringValue,
           !directResult.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return directResult.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        let candidateKeys = ["text", "message", "summary", "stdout", "stderr", "output_text", "outputText"]
        var extracted: [String] = []
        for key in candidateKeys {
            if let value = firstString(forKey: key, in: .object(itemObject)),
               !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                extracted.append(value.trimmingCharacters(in: .whitespacesAndNewlines))
            }
        }

        if extracted.isEmpty,
           let contentString = flattenNestedText(from: .object(itemObject)) {
            return contentString
        }

        if extracted.isEmpty {
            return nil
        }

        return extracted.joined(separator: "\n\n")
    }

    func isLikelyFileChangeToolCall(
        itemObject: IncomingParamsObject?,
        fallbackText: String?
    ) -> Bool {
        guard let itemObject else {
            return looksLikePatchText(fallbackText ?? "")
        }

        let descriptor = toolCallDescriptor(from: itemObject)
        let normalizedDescriptor = descriptor
            .lowercased()
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: " ", with: "")

        let hasToolHint = normalizedDescriptor.contains("filechange")
            || normalizedDescriptor.contains("applypatch")
            || normalizedDescriptor.contains("patchapply")
            || normalizedDescriptor.contains("diff")
            || normalizedDescriptor.contains("edit")
            || normalizedDescriptor.contains("write")
            || normalizedDescriptor.contains("rename")
            || normalizedDescriptor.contains("delete")
            || normalizedDescriptor.contains("remove")
            || normalizedDescriptor.contains("create")
            || normalizedDescriptor.contains("add")
            || normalizedDescriptor.contains("move")

        let hasStructuredChanges = extractToolCallChanges(from: itemObject) != nil
        let hasDiffPayload = extractToolCallUnifiedDiff(from: itemObject).map(looksLikePatchText) ?? false
        let hasPatchLikeText = looksLikePatchText(fallbackText ?? "")

        return (hasToolHint && (hasStructuredChanges || hasDiffPayload || hasPatchLikeText))
            || hasDiffPayload
            || hasPatchLikeText
    }

    func toolCallDescriptor(from itemObject: IncomingParamsObject) -> String {
        let nestedTool = itemObject["tool"]?.objectValue
        let nestedCall = itemObject["call"]?.objectValue
        var parts = [
            itemObject["kind"]?.stringValue,
            itemObject["name"]?.stringValue,
            itemObject["tool"]?.stringValue,
            itemObject["tool_name"]?.stringValue,
            itemObject["toolName"]?.stringValue,
            itemObject["title"]?.stringValue,
            nestedTool?["kind"]?.stringValue,
            nestedTool?["name"]?.stringValue,
            nestedTool?["type"]?.stringValue,
            nestedTool?["title"]?.stringValue,
            nestedCall?["kind"]?.stringValue,
            nestedCall?["name"]?.stringValue,
            nestedCall?["type"]?.stringValue,
            nestedCall?["title"]?.stringValue,
        ]
        if let recursiveToolName = firstString(forKey: "tool_name", in: .object(itemObject)) {
            parts.append(recursiveToolName)
        }
        if let recursiveKind = firstString(forKey: "kind", in: .object(itemObject)) {
            parts.append(recursiveKind)
        }
        if let recursiveName = firstString(forKey: "name", in: .object(itemObject)) {
            parts.append(recursiveName)
        }
        return parts
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    private func decodeFileChangeEntries(
        from rawChanges: JSONValue?
    ) -> [(path: String, kind: String, diff: String, inlineTotals: (additions: Int, deletions: Int)?)] {
        var changeObjects: [IncomingParamsObject] = []

        if let array = rawChanges?.arrayValue {
            for value in array {
                if let object = value.objectValue {
                    changeObjects.append(object)
                }
            }
        } else if let objectMap = rawChanges?.objectValue {
            for key in objectMap.keys.sorted() {
                guard var object = objectMap[key]?.objectValue else { continue }
                if object["path"] == nil {
                    object["path"] = .string(key)
                }
                changeObjects.append(object)
            }
        }

        return changeObjects.compactMap { changeObject in
            let path = decodeChangePath(from: changeObject)
            let kind = decodeChangeKind(from: changeObject)

            var diff = decodeChangeDiff(from: changeObject)
            let totals = decodeChangeInlineTotals(from: changeObject)
            if diff.isEmpty,
               let content = changeObject["content"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
               !content.isEmpty {
                diff = synthesizeUnifiedDiffFromContent(content, kind: kind, path: path)
            }

            return (path: path, kind: kind, diff: diff, inlineTotals: totals)
        }
    }

    private func decodeChangePath(from changeObject: IncomingParamsObject) -> String {
        let candidates = [
            changeObject["path"]?.stringValue,
            changeObject["file"]?.stringValue,
            changeObject["file_path"]?.stringValue,
            changeObject["filePath"]?.stringValue,
            changeObject["relative_path"]?.stringValue,
            changeObject["relativePath"]?.stringValue,
            changeObject["new_path"]?.stringValue,
            changeObject["newPath"]?.stringValue,
            changeObject["to"]?.stringValue,
            changeObject["target"]?.stringValue,
            changeObject["name"]?.stringValue,
            changeObject["old_path"]?.stringValue,
            changeObject["oldPath"]?.stringValue,
            changeObject["from"]?.stringValue,
        ]

        for candidate in candidates {
            guard let candidate else { continue }
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed
            }
        }

        return "unknown"
    }

    private func decodeChangeKind(from changeObject: IncomingParamsObject) -> String {
        if let kindString = changeObject["kind"]?.stringValue,
           !kindString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return kindString
        }
        if let actionString = changeObject["action"]?.stringValue,
           !actionString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return actionString
        }
        if let kindType = changeObject["kind"]?.objectValue?["type"]?.stringValue,
           !kindType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return kindType
        }
        if let typeString = changeObject["type"]?.stringValue,
           !typeString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return typeString
        }
        return "update"
    }

    private func decodeChangeDiff(from changeObject: IncomingParamsObject) -> String {
        let diff = changeObject["diff"]?.stringValue
            ?? changeObject["unified_diff"]?.stringValue
            ?? changeObject["unifiedDiff"]?.stringValue
            ?? changeObject["patch"]?.stringValue
            ?? changeObject["delta"]?.stringValue
            ?? ""
        return diff.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func decodeChangeInlineTotals(
        from changeObject: IncomingParamsObject
    ) -> (additions: Int, deletions: Int)? {
        let additions = decodeNumericField(
            from: changeObject,
            keys: [
                "additions",
                "lines_added",
                "line_additions",
                "lineAdditions",
                "added",
                "insertions",
                "inserted",
                "num_added",
            ]
        ) ?? 0
        let deletions = decodeNumericField(
            from: changeObject,
            keys: [
                "deletions",
                "lines_deleted",
                "line_deletions",
                "lineDeletions",
                "removed",
                "deleted",
                "num_deleted",
                "num_removed",
            ]
        ) ?? 0

        guard additions > 0 || deletions > 0 else { return nil }
        return (additions: additions, deletions: deletions)
    }

    private func decodeNumericField(
        from object: IncomingParamsObject,
        keys: [String]
    ) -> Int? {
        for key in keys {
            if let intValue = object[key]?.intValue {
                return intValue
            }
            if let doubleValue = object[key]?.doubleValue {
                return Int(doubleValue)
            }
            if let stringValue = object[key]?.stringValue,
               let parsed = Int(stringValue.trimmingCharacters(in: .whitespacesAndNewlines)) {
                return parsed
            }
        }
        return nil
    }

    private func synthesizeUnifiedDiffFromContent(
        _ content: String,
        kind: String,
        path: String
    ) -> String {
        let normalizedKind = kind.lowercased()
        let contentLines = content
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)

        if normalizedKind.contains("add") || normalizedKind.contains("create") {
            var lines: [String] = [
                "diff --git a/\(path) b/\(path)",
                "new file mode 100644",
                "--- /dev/null",
                "+++ b/\(path)",
            ]
            lines.append(contentsOf: contentLines.map { "+\($0)" })
            return lines.joined(separator: "\n")
        }

        if normalizedKind.contains("delete") || normalizedKind.contains("remove") {
            var lines: [String] = [
                "diff --git a/\(path) b/\(path)",
                "deleted file mode 100644",
                "--- a/\(path)",
                "+++ /dev/null",
            ]
            lines.append(contentsOf: contentLines.map { "-\($0)" })
            return lines.joined(separator: "\n")
        }

        return ""
    }

    private func normalizedFileChangeStatus(from itemObject: IncomingParamsObject, isCompleted: Bool) -> String {
        let nestedOutput = itemObject["output"]?.objectValue
        let nestedResult = itemObject["result"]?.objectValue
        let nestedPayload = itemObject["payload"]?.objectValue
        let nestedData = itemObject["data"]?.objectValue
        let status = firstNonEmptyString([
            itemObject["status"]?.stringValue,
            nestedOutput?["status"]?.stringValue,
            nestedResult?["status"]?.stringValue,
            nestedPayload?["status"]?.stringValue,
            nestedData?["status"]?.stringValue,
        ])
        if let status {
            return status
        }
        return isCompleted ? "completed" : "inProgress"
    }

    private func extractToolCallChanges(from itemObject: IncomingParamsObject) -> JSONValue? {
        let candidateKeys = [
            "changes",
            "file_changes",
            "fileChanges",
            "files",
            "edits",
            "modified_files",
            "modifiedFiles",
            "patches",
        ]

        if let direct = firstValue(forAnyKey: candidateKeys, in: .object(itemObject)) {
            return direct
        }
        return nil
    }

    private func extractToolCallUnifiedDiff(from itemObject: IncomingParamsObject) -> String? {
        let candidateKeys = ["diff", "unified_diff", "unifiedDiff", "patch"]
        for key in candidateKeys {
            if let value = firstString(forKey: key, in: .object(itemObject)) {
                return value
            }
        }
        return nil
    }
}
