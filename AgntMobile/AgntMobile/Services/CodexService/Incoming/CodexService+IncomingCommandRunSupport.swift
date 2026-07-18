// FILE: CodexService+IncomingCommandRunSupport.swift
// Purpose: Command-run parsing helpers used by inbound command execution handlers.
// Layer: Service support
// Exports: CommandRunViewState and command execution decode helpers
// Depends on: Foundation

import Foundation

enum CommandRunPhase: String {
    case running
    case completed
    case failed
    case stopped
}

struct CommandRunViewState {
    let itemId: String?
    let phase: CommandRunPhase
    let shortCommand: String
    let fullCommand: String
    let cwd: String?
    let exitCode: Int?
    let durationMs: Int?
}

func commandExecutionOutputChunk(
    paramsObject: IncomingParamsObject,
    eventObject: IncomingParamsObject?
) -> String? {
    let paramsCandidates: [String?] = [
        paramsObject["delta"]?.stringValue,
        paramsObject["textDelta"]?.stringValue,
        paramsObject["text"]?.stringValue,
        paramsObject["output"]?.stringValue,
    ]
    if let paramsChunk = firstNonEmptyString(paramsCandidates) {
        return paramsChunk
    }

    let eventCandidates: [String?] = [
        eventObject?["delta"]?.stringValue,
        eventObject?["text"]?.stringValue,
    ]
    return firstNonEmptyString(eventCandidates)
}

func decodeCommandRunViewState(
    payloadObject: IncomingParamsObject,
    paramsObject: IncomingParamsObject?,
    eventType: String?
) -> CommandRunViewState {
    let status = firstNonEmptyString(
        commandExecutionStatusCandidates(payloadObject: payloadObject, paramsObject: paramsObject)
    )
    let phase = commandRunPhase(from: status, eventType: eventType)

    let rawCommand = extractCommandExecutionCommand(from: payloadObject) ?? "command"
    let shortCommand = shortCommandPreview(from: rawCommand)
    let cwd = firstNonEmptyString(
        commandExecutionWorkingDirectoryCandidates(payloadObject: payloadObject, paramsObject: paramsObject)
    )
    let itemId = commandExecutionItemID(payloadObject: payloadObject, paramsObject: paramsObject)

    let exitCode = commandExecutionExitCode(from: payloadObject)
    let durationMs = commandExecutionDurationMs(from: payloadObject)

    return CommandRunViewState(
        itemId: itemId,
        phase: phase,
        shortCommand: shortCommand,
        fullCommand: rawCommand,
        cwd: cwd,
        exitCode: exitCode,
        durationMs: durationMs
    )
}

func extractCommandExecutionCommand(from itemObject: IncomingParamsObject) -> String? {
    if let commandArray = extractLegacyCommandArray(itemObject["command"]) {
        return commandArray
    }

    let candidates = ["command", "cmd", "raw_command", "rawCommand", "input", "invocation"]
    for key in candidates {
        if let value = firstString(forKey: key, in: .object(itemObject)) {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed
            }
        }
    }
    return nil
}

func shortCommandPreview(from rawCommand: String, maxLength: Int = 92) -> String {
    let trimmed = rawCommand.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "command" }

    let compact = trimmed.replacingOccurrences(
        of: #"\s+"#,
        with: " ",
        options: .regularExpression
    )
    let unwrapped = unwrapShellCommandIfPresent(compact)
    let normalized = unwrapped.replacingOccurrences(
        of: #"\s+"#,
        with: " ",
        options: .regularExpression
    )

    let components = normalized
        .split(separator: " ", omittingEmptySubsequences: true)
        .map(String.init)
    guard !components.isEmpty else {
        return "command"
    }

    var preview = components.joined(separator: " ")
    if preview.count > maxLength {
        let cutoff = preview.index(preview.startIndex, offsetBy: maxLength - 1)
        preview = String(preview[..<cutoff]) + "..."
    }
    return preview
}

func unwrapShellCommandIfPresent(_ command: String) -> String {
    let tokens = command
        .split(separator: " ", omittingEmptySubsequences: true)
        .map(String.init)
    guard !tokens.isEmpty else { return command }

    let shellNames = ["bash", "zsh", "sh", "fish"]
    var shellIndex = 0

    if tokens.count >= 2 {
        let first = tokens[0].lowercased()
        let second = tokens[1].lowercased()
        if (first == "env" || first.hasSuffix("/env")),
           shellNames.contains(where: { second == $0 || second.hasSuffix("/\($0)") }) {
            shellIndex = 1
        }
    }

    let shell = tokens[shellIndex].lowercased()
    guard shellNames.contains(where: { shell == $0 || shell.hasSuffix("/\($0)") }) else {
        return command
    }

    var index = shellIndex + 1
    while index < tokens.count {
        let token = tokens[index]
        if token == "-c" || token == "-lc" || token == "-cl" || token == "-ic" || token == "-ci" {
            index += 1
            guard index < tokens.count else { return command }
            return stripWrappingQuotes(from: tokens[index...].joined(separator: " "))
        }
        if token.hasPrefix("-") {
            index += 1
            continue
        }
        return stripWrappingQuotes(from: tokens[index...].joined(separator: " "))
    }

    return command
}

private func commandExecutionStatusCandidates(
    payloadObject: IncomingParamsObject,
    paramsObject: IncomingParamsObject?
) -> [String?] {
    [
        payloadObject["status"]?.stringValue,
        payloadObject["result"]?.objectValue?["status"]?.stringValue,
        payloadObject["output"]?.objectValue?["status"]?.stringValue,
        paramsObject?["status"]?.stringValue,
        paramsObject?["event"]?.objectValue?["status"]?.stringValue,
    ]
}

private func commandExecutionWorkingDirectoryCandidates(
    payloadObject: IncomingParamsObject,
    paramsObject: IncomingParamsObject?
) -> [String?] {
    [
        payloadObject["cwd"]?.stringValue,
        payloadObject["working_directory"]?.stringValue,
        paramsObject?["cwd"]?.stringValue,
    ]
}

private func commandExecutionItemID(
    payloadObject: IncomingParamsObject,
    paramsObject: IncomingParamsObject?
) -> String? {
    let payloadCandidates: [String?] = [
        payloadObject["id"]?.stringValue,
        payloadObject["call_id"]?.stringValue,
        payloadObject["callId"]?.stringValue,
    ]
    if let payloadID = firstNonEmptyString(payloadCandidates) {
        return payloadID
    }

    let paramsCandidates: [String?] = [
        paramsObject?["itemId"]?.stringValue,
        paramsObject?["item_id"]?.stringValue,
    ]
    return firstNonEmptyString(paramsCandidates)
}

private func commandExecutionExitCode(from payloadObject: IncomingParamsObject) -> Int? {
    let directCandidates: [Int?] = [
        payloadObject["exitCode"]?.intValue,
        payloadObject["exit_code"]?.intValue,
    ]
    if let direct = firstNonNilInt(directCandidates) {
        return direct
    }

    let resultObject = payloadObject["result"]?.objectValue
    let nestedCandidates: [Int?] = [
        resultObject?["exitCode"]?.intValue,
        resultObject?["exit_code"]?.intValue,
    ]
    return firstNonNilInt(nestedCandidates)
}

private func commandExecutionDurationMs(from payloadObject: IncomingParamsObject) -> Int? {
    let directCandidates: [Int?] = [
        payloadObject["durationMs"]?.intValue,
        payloadObject["duration_ms"]?.intValue,
    ]
    if let direct = firstNonNilInt(directCandidates) {
        return direct
    }

    let resultObject = payloadObject["result"]?.objectValue
    let nestedCandidates: [Int?] = [
        resultObject?["durationMs"]?.intValue,
    ]
    return firstNonNilInt(nestedCandidates)
}

private func firstNonNilInt(_ values: [Int?]) -> Int? {
    values.compactMap { $0 }.first
}

private func commandRunPhase(from rawStatus: String?, eventType: String?) -> CommandRunPhase {
    let normalizedStatus = rawStatus?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased() ?? ""
    let normalizedEventType = eventType?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased() ?? ""

    if normalizedStatus.contains("fail") || normalizedStatus.contains("error") {
        return .failed
    }
    if normalizedStatus.contains("cancel") || normalizedStatus.contains("abort") || normalizedStatus.contains("interrupt") {
        return .stopped
    }
    if normalizedStatus.contains("complete") || normalizedStatus.contains("success") || normalizedStatus.contains("done") {
        return .completed
    }

    if normalizedEventType == "exec_command_end" {
        return .completed
    }
    return .running
}

private func extractLegacyCommandArray(_ value: JSONValue?) -> String? {
    guard let value else { return nil }
    if let array = value.arrayValue {
        let parts = array.compactMap { item -> String? in
            let text = item.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
            return (text?.isEmpty == false) ? text : nil
        }
        guard !parts.isEmpty else { return nil }
        return parts.joined(separator: " ")
    }
    return value.stringValue
}

private func stripWrappingQuotes(from input: String) -> String {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count >= 2 else { return trimmed }

    if (trimmed.hasPrefix("'") && trimmed.hasSuffix("'"))
        || (trimmed.hasPrefix("\"") && trimmed.hasSuffix("\"")) {
        return String(trimmed.dropFirst().dropLast())
    }
    return trimmed
}
