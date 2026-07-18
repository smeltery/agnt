import Foundation

extension CodexService {
    func decodeFileChangeItemText(from itemObject: [String: JSONValue]) -> String {
        let status = itemObject["status"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedStatus = (status?.isEmpty == false) ? status! : "completed"

        var sections: [String] = ["Status: \(normalizedStatus)"]
        let changes = decodeHistoryFileChangeEntries(from: itemObject["changes"])
        let renderedChanges = changes.map { entry -> String in
            var body = "Path: \(entry.path)\nKind: \(entry.kind)"
            if let totals = entry.inlineTotals {
                body += "\nTotals: +\(totals.additions) -\(totals.deletions)"
            }
            if !entry.diff.isEmpty {
                body += "\n\n`@agnt``diff\n\(entry.diff)\n`@agnt``"
            }
            return body
        }

        if !renderedChanges.isEmpty {
            sections.append(renderedChanges.joined(separator: "\n\n---\n\n"))
        }

        return sections.joined(separator: "\n\n")
    }

    // Splits history tool items into dedicated command, file-change, or compact generic activity rows.
    func decodeHistoryToolCallItem(from itemObject: [String: JSONValue]) -> (kind: CodexMessageKind, text: String)? {
        if isHistoryCommandToolCall(itemObject),
           let commandText = decodeHistoryCommandToolCallText(from: itemObject) {
            return (.commandExecution, commandText)
        }
        if let fileChangeText = decodeHistoryToolCallFileChangeText(from: itemObject) {
            return (.fileChange, fileChangeText)
        }
        if let activityText = decodeHistoryToolActivityText(from: itemObject) {
            return (.toolActivity, activityText)
        }
        return nil
    }

    func decodeHistoryDiffItemText(from itemObject: [String: JSONValue]) -> String? {
        decodeHistoryToolCallFileChangeText(from: itemObject)
    }

    func decodeHistoryToolCallFileChangeText(from itemObject: [String: JSONValue]) -> String? {
        let status = decodeHistoryNestedStatus(from: itemObject) ?? "completed"

        var synthetic = itemObject
        if synthetic["status"] == nil {
            synthetic["status"] = .string(status)
        }

        if synthetic["changes"] == nil,
           let extractedChanges = decodeHistoryFirstValue(
               forAnyKey: [
                   "changes",
                   "file_changes",
                   "fileChanges",
                   "files",
                   "edits",
                   "modified_files",
                   "modifiedFiles",
                   "patches",
               ],
               in: .object(itemObject)
           ) {
            synthetic["changes"] = extractedChanges
        }

        let fileEntries = decodeHistoryFileChangeEntries(from: synthetic["changes"])
        if !fileEntries.isEmpty {
            return decodeFileChangeItemText(from: synthetic)
        }

        if let diff = decodeHistoryFirstString(
            forAnyKey: ["diff", "unified_diff", "unifiedDiff", "patch"],
            in: .object(itemObject)
        ) {
            let trimmedDiff = diff.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedDiff.isEmpty {
                return "Status: \(status)\n\n`@agnt``diff\n\(trimmedDiff)\n`@agnt``"
            }
        }

        return nil
    }

    func decodeHistoryToolActivityText(from itemObject: [String: JSONValue]) -> String? {
        if let output = decodeHistoryFirstString(
            forAnyKey: [
                "text",
                "message",
                "summary",
                "stdout",
                "stderr",
                "output_text",
                "outputText",
            ],
            in: .object(itemObject)
        ) {
            let lines = output
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty && $0.count <= 140 }
            let acceptedPrefixes = [
                "running ",
                "read ",
                "search ",
                "searched ",
                "exploring ",
                "list ",
                "listing ",
                "open ",
                "opened ",
                "find ",
                "finding ",
                "capture ",
                "captured ",
                "check ",
                "checked ",
                "create ",
                "created ",
                "edit ",
                "edited ",
                "request ",
                "requested ",
                "run ",
                "ran ",
                "update ",
                "updated ",
                "write ",
                "wrote ",
                "apply ",
                "applied ",
            ]
            let activityLines = lines.filter { line in
                let lower = line.lowercased()
                return acceptedPrefixes.contains { lower.hasPrefix($0) }
            }
            if !activityLines.isEmpty {
                return activityLines.joined(separator: "\n")
            }
        }

        let nestedTool = itemObject["tool"]?.objectValue
        let nestedCall = itemObject["call"]?.objectValue
        let descriptor = firstNonEmptyString([
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
        ])
        let summary = toolActivitySummaryLine(
            descriptor: descriptor,
            rawStatus: decodeHistoryNestedStatus(from: itemObject),
            isCompleted: true
        )
        return summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : summary
    }

    func isHistoryCommandToolCall(_ itemObject: [String: JSONValue]) -> Bool {
        let rawTool = firstNonEmptyString([
            itemObject["name"]?.stringValue,
            itemObject["tool_name"]?.stringValue,
            itemObject["toolName"]?.stringValue,
            itemObject["tool"]?.stringValue,
        ])?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return rawTool == "exec_command" || rawTool == "shell_command"
    }

    func decodeHistoryCommandToolCallText(from itemObject: [String: JSONValue]) -> String? {
        let argumentsObject = decodeHistoryToolArgumentsObject(from: itemObject)
        let status = decodeHistoryNestedStatus(from: itemObject) ?? "completed"
        let phase = normalizedHistoryCommandPhase(status)
        let command = firstNonEmptyString([
            decodeHistoryFirstString(
                forAnyKey: ["command", "cmd", "raw_command", "rawCommand", "input", "invocation"],
                in: .object(itemObject)
            ),
            decodeHistoryFirstString(
                forAnyKey: ["command", "cmd", "raw_command", "rawCommand", "input", "invocation"],
                in: .object(argumentsObject)
            ),
        ])
        guard let command else { return nil }
        return "\(phase) \(shortHistoryCommand(command))"
    }

    func decodeHistoryToolArgumentsObject(from itemObject: [String: JSONValue]) -> [String: JSONValue] {
        guard let argumentsValue = itemObject["arguments"] ?? itemObject["input"] else {
            return [:]
        }
        if let object = argumentsValue.objectValue {
            return object
        }
        guard let text = argumentsValue.stringValue,
              let data = text.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(JSONValue.self, from: data),
              let object = decoded.objectValue else {
            return [:]
        }
        return object
    }

    func decodeHistoryFileChangeEntries(
        from rawChanges: JSONValue?
    ) -> [(path: String, kind: String, diff: String, inlineTotals: (additions: Int, deletions: Int)?)] {
        var changeObjects: [[String: JSONValue]] = []

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

        return changeObjects.map { changeObject in
            let path = decodeHistoryChangePath(from: changeObject)
            let kind = decodeHistoryChangeKind(from: changeObject)
            var diff = decodeHistoryChangeDiff(from: changeObject)
            let totals = decodeHistoryChangeInlineTotals(from: changeObject)
            if diff.isEmpty,
               let content = changeObject["content"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
               !content.isEmpty {
                diff = synthesizeHistoryUnifiedDiffFromContent(content, kind: kind, path: path)
            }
            return (path: path, kind: kind, diff: diff, inlineTotals: totals)
        }
    }

    func decodeHistoryChangePath(from changeObject: [String: JSONValue]) -> String {
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

    func decodeHistoryChangeKind(from changeObject: [String: JSONValue]) -> String {
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

    func decodeHistoryChangeDiff(from changeObject: [String: JSONValue]) -> String {
        let diff = changeObject["diff"]?.stringValue
            ?? changeObject["unified_diff"]?.stringValue
            ?? changeObject["unifiedDiff"]?.stringValue
            ?? changeObject["patch"]?.stringValue
            ?? changeObject["delta"]?.stringValue
            ?? ""
        return diff.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func decodeHistoryChangeInlineTotals(
        from changeObject: [String: JSONValue]
    ) -> (additions: Int, deletions: Int)? {
        let additions = decodeHistoryNumericField(
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
        let deletions = decodeHistoryNumericField(
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

    func decodeHistoryNumericField(
        from object: [String: JSONValue],
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

    func synthesizeHistoryUnifiedDiffFromContent(
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

    func decodeHistoryNestedStatus(from itemObject: [String: JSONValue]) -> String? {
        decodeHistoryFirstString(
            forAnyKey: ["status"],
            in: .object(itemObject)
        )
    }
}
