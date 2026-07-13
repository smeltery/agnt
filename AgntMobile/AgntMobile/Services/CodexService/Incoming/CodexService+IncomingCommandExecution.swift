// FILE: CodexService+IncomingCommandExecution.swift
// Purpose: Inbound command-execution notification decoding and row publishing.
// Layer: Service
// Exports: CodexService command-execution incoming handlers
// Depends on: JSONValue, CommandExecutionDetails

import Foundation

private struct CommandExecutionMessageContext {
    let threadId: String
    let turnId: String?
    let itemId: String?
}

extension CodexService {
    func appendCommandExecutionDelta(from paramsObject: IncomingParamsObject?) {
        guard let paramsObject else { return }
        let eventObject = envelopeEventObject(from: paramsObject)
        let itemObject = extractIncomingItemObject(from: paramsObject, eventObject: eventObject)
        let payloadObject = itemObject ?? eventObject ?? paramsObject

        guard let context = resolveCommandExecutionMessageContext(
            paramsObject: paramsObject,
            eventObject: eventObject,
            itemObject: itemObject
        ) else {
            return
        }

        if let itemId = context.itemId, !itemId.isEmpty {
            let hasCommandHint = extractCommandExecutionCommand(from: payloadObject) != nil
                || payloadObject["command"] != nil
                || payloadObject["cmd"] != nil
            if !hasCommandHint {
                if existingCommandExecutionRow(threadId: context.threadId, itemId: itemId) != nil {
                    return
                }
            }
        }

        let statusText = decodeCommandExecutionStatusText(
            payloadObject,
            threadId: context.threadId,
            isCompleted: false
        )
        appendCommandExecutionOutputToDetails(itemId: context.itemId, paramsObject: paramsObject, eventObject: eventObject)
        publishCommandExecutionStatus(
            context: context,
            statusText: statusText,
            isStreaming: true
        )
    }

    func handleCommandExecutionTerminalInteraction(from paramsObject: IncomingParamsObject?) {
        guard let paramsObject else { return }
        let eventObject = envelopeEventObject(from: paramsObject)
        guard let context = resolveCommandExecutionMessageContext(
            paramsObject: paramsObject,
            eventObject: eventObject
        ) else {
            return
        }
        guard let itemId = context.itemId,
              !itemId.isEmpty else {
            return
        }

        let eventType = commandExecutionEventType(eventObject: eventObject, paramsObject: paramsObject)
        let state = decodeCommandRunViewState(
            payloadObject: eventObject ?? paramsObject,
            paramsObject: paramsObject,
            eventType: eventType
        )
        let statusText = commandExecutionStatusText(for: state)
        let existingRunRow = existingCommandExecutionRow(threadId: context.threadId, itemId: itemId)

        if let existingRunRow {
            // Ignore late status-less terminal interaction updates that would regress a completed row.
            if !existingRunRow.isStreaming, state.phase == .running {
                return
            }

            if state.shortCommand.lowercased() != "command" || state.phase != .running {
                publishCommandExecutionStatus(
                    context: context,
                    statusText: statusText,
                    isStreaming: state.phase == .running
                )
            }
            return
        }

        publishCommandExecutionStatus(
            context: context,
            statusText: statusText,
            isStreaming: state.phase == .running
        )
    }

    func handleLegacyCommandExecutionEvent(
        eventType: String,
        payload: IncomingParamsObject,
        paramsObject: IncomingParamsObject?
    ) -> Bool {
        guard eventType == "exec_command_begin"
            || eventType == "exec_command_output_delta"
            || eventType == "exec_command_end" else {
            return false
        }

        var normalizedParams = paramsObject ?? [:]
        if normalizedParams["event"] == nil {
            normalizedParams["event"] = .object(payload)
        }

        if normalizedParams["itemId"] == nil,
           let itemId = firstStringValue(in: payload, keys: ["call_id", "callId"]) {
            normalizedParams["itemId"] = .string(itemId)
        }

        if normalizedParams["turnId"] == nil,
           let turnId = firstNonEmptyCommandString([
            firstStringValue(in: payload, keys: ["turn_id", "turnId"]),
            firstStringValue(in: paramsObject, keys: ["id"]),
           ]) {
            normalizedParams["turnId"] = .string(turnId)
        }

        if normalizedParams["threadId"] == nil,
           let threadId = firstNonEmptyCommandString([
            firstStringValue(in: payload, keys: ["threadId", "thread_id", "conversationId"]),
            firstStringValue(in: paramsObject, keys: ["conversationId"]),
           ]) {
            normalizedParams["threadId"] = .string(threadId)
        }

        let turnId = extractTurnID(from: normalizedParams)
        guard let threadId = resolveThreadID(from: normalizedParams, turnIdHint: turnId) else {
            return false
        }
        if let turnId {
            threadIdByTurnID[turnId] = threadId
        }

        let state = decodeCommandRunViewState(
            payloadObject: payload,
            paramsObject: normalizedParams,
            eventType: eventType
        )
        let itemId = state.itemId
            ?? extractItemID(from: normalizedParams, eventObject: payload)
            ?? firstStringValue(in: payload, keys: ["call_id", "callId"])

        if eventType == "exec_command_output_delta" {
            if let itemId, !itemId.isEmpty {
                // Ensure details entry exists so output is captured.
                if commandExecutionDetailsByItemID[itemId] == nil {
                    upsertCommandExecutionDetails(from: state, threadId: threadId, isCompleted: false)
                }
                appendCommandExecutionOutputToDetails(itemId: itemId, paramsObject: normalizedParams, eventObject: payload)

                let hasExistingRunRow = messagesByThread[threadId]?.contains(where: { message in
                    message.role == .system
                        && message.kind == .commandExecution
                        && message.itemId == itemId
                }) ?? false
                if !hasExistingRunRow {
                    upsertStreamingSystemItemMessage(
                        threadId: threadId,
                        turnId: turnId,
                        itemId: itemId,
                        kind: .commandExecution,
                        text: commandExecutionStatusText(for: state),
                        isStreaming: true
                    )
                }
            }
            return true
        }

        let isCompleted = (eventType == "exec_command_end")
        upsertCommandExecutionDetails(from: state, threadId: threadId, isCompleted: isCompleted)
        let statusText = commandExecutionStatusText(for: state)
        if let itemId, !itemId.isEmpty {
            if isCompleted {
                completeStreamingSystemItemMessage(
                    threadId: threadId,
                    turnId: turnId,
                    itemId: itemId,
                    kind: .commandExecution,
                    text: statusText
                )
            } else {
                upsertStreamingSystemItemMessage(
                    threadId: threadId,
                    turnId: turnId,
                    itemId: itemId,
                    kind: .commandExecution,
                    text: statusText,
                    isStreaming: true
                )
            }
        } else if let turnId, !turnId.isEmpty {
            if isCompleted {
                completeStreamingSystemTurnMessage(
                    threadId: threadId,
                    turnId: turnId,
                    kind: .commandExecution,
                    text: statusText
                )
            } else {
                upsertStreamingSystemTurnMessage(
                    threadId: threadId,
                    turnId: turnId,
                    kind: .commandExecution,
                    text: statusText,
                    isStreaming: true
                )
            }
        } else {
            appendSystemMessage(
                threadId: threadId,
                text: statusText,
                turnId: turnId,
                itemId: itemId,
                kind: .commandExecution,
                isStreaming: !isCompleted
            )
        }

        if isCompleted {
            maybeAppendPushResetMarker(from: state, threadId: threadId)
        }

        return true
    }

    func decodeCommandExecutionStatusText(
        _ itemObject: IncomingParamsObject,
        threadId: String? = nil,
        isCompleted: Bool
    ) -> String {
        let state = decodeCommandRunViewState(
            payloadObject: itemObject,
            paramsObject: nil,
            eventType: isCompleted ? "exec_command_end" : "exec_command_begin"
        )
        upsertCommandExecutionDetails(from: state, threadId: threadId, isCompleted: isCompleted)
        return commandExecutionStatusText(for: state)
    }

    private func resolveCommandExecutionMessageContext(
        paramsObject: IncomingParamsObject,
        eventObject: IncomingParamsObject?,
        itemObject: IncomingParamsObject? = nil
    ) -> CommandExecutionMessageContext? {
        let turnId = extractTurnID(from: paramsObject)
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) else {
            return nil
        }
        let resolvedTurnId = turnId ?? activeTurnIdByThread[threadId]
        if let resolvedTurnId {
            threadIdByTurnID[resolvedTurnId] = threadId
        }

        let itemId = extractItemID(
            from: paramsObject,
            eventObject: eventObject,
            itemObject: itemObject
        )
        return CommandExecutionMessageContext(
            threadId: threadId,
            turnId: resolvedTurnId,
            itemId: itemId
        )
    }

    private func commandExecutionEventType(
        eventObject: IncomingParamsObject?,
        paramsObject: IncomingParamsObject
    ) -> String? {
        let rawEventType = firstNonEmptyCommandString([
            eventObject?["type"]?.stringValue,
            eventObject?["event_type"]?.stringValue,
            paramsObject["type"]?.stringValue,
            paramsObject["event_type"]?.stringValue,
        ])
        return rawEventType?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    private func existingCommandExecutionRow(threadId: String, itemId: String) -> CodexMessage? {
        messagesByThread[threadId]?.first(where: { message in
            message.role == .system
                && message.kind == .commandExecution
                && message.itemId == itemId
        })
    }

    private func publishCommandExecutionStatus(
        context: CommandExecutionMessageContext,
        statusText: String,
        isStreaming: Bool
    ) {
        if let itemId = context.itemId, !itemId.isEmpty {
            upsertStreamingSystemItemMessage(
                threadId: context.threadId,
                turnId: context.turnId,
                itemId: itemId,
                kind: .commandExecution,
                text: statusText,
                isStreaming: isStreaming
            )
            return
        }

        if let turnId = context.turnId, !turnId.isEmpty {
            upsertStreamingSystemTurnMessage(
                threadId: context.threadId,
                turnId: turnId,
                kind: .commandExecution,
                text: statusText,
                isStreaming: isStreaming
            )
            return
        }

        appendSystemMessage(
            threadId: context.threadId,
            text: statusText,
            turnId: context.turnId,
            kind: .commandExecution,
            isStreaming: isStreaming
        )
    }

    private func commandExecutionStatusText(for state: CommandRunViewState) -> String {
        "\(state.phase.rawValue) \(state.shortCommand)"
    }

    private func upsertCommandExecutionDetails(
        from state: CommandRunViewState,
        threadId: String? = nil,
        isCompleted: Bool
    ) {
        guard let itemId = state.itemId, !itemId.isEmpty else { return }
        if let threadId {
            adoptManagedWorktreeProjectPathIfNeeded(threadId: threadId, projectPath: state.cwd)
        }
        if var existing = commandExecutionDetailsByItemID[itemId] {
            if state.fullCommand.count > existing.fullCommand.count {
                existing.fullCommand = state.fullCommand
            }
            if let cwd = state.cwd, existing.cwd == nil {
                existing.cwd = cwd
            }
            existing.exitCode = state.exitCode ?? existing.exitCode
            existing.durationMs = state.durationMs ?? existing.durationMs
            commandExecutionDetailsByItemID[itemId] = existing
        } else {
            commandExecutionDetailsByItemID[itemId] = CommandExecutionDetails(
                fullCommand: state.fullCommand,
                cwd: state.cwd,
                exitCode: state.exitCode,
                durationMs: state.durationMs,
                outputTail: ""
            )
        }
    }

    private func appendCommandExecutionOutputToDetails(
        itemId: String?,
        paramsObject: IncomingParamsObject,
        eventObject: IncomingParamsObject?
    ) {
        guard let itemId, !itemId.isEmpty else { return }
        guard let chunk = commandExecutionOutputChunk(paramsObject: paramsObject, eventObject: eventObject),
              !chunk.isEmpty else { return }
        guard var details = commandExecutionDetailsByItemID[itemId] else { return }
        details.appendOutput(chunk)
        commandExecutionDetailsByItemID[itemId] = details
    }

    // Mirrors toolbar push resets for successful `git push` commands executed by the agent.
    private func maybeAppendPushResetMarker(from state: CommandRunViewState, threadId: String) {
        guard state.phase == .completed else {
            return
        }

        let normalizedCommand = unwrapShellCommandIfPresent(state.fullCommand)
            .lowercased()
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        guard commandContainsGitPush(normalizedCommand) else {
            return
        }

        appendHiddenPushResetMarkers(
            threadId: threadId,
            workingDirectory: state.cwd,
            branch: "",
            remote: nil
        )
    }

    private func commandContainsGitPush(_ command: String) -> Bool {
        guard !command.isEmpty else {
            return false
        }

        let patterns = [
            #"(^|\s|&&|\|\||;)\s*git\s+push(\s|$)"#,
            #"(^|\s|&&|\|\||;)\s*git\s+-c\s+\S+\s+push(\s|$)"#,
            #"(^|\s|&&|\|\||;)\s*git\s+-C\s+\S+\s+push(\s|$)"#,
        ]

        return patterns.contains { pattern in
            command.range(of: pattern, options: .regularExpression) != nil
        }
    }

    private func firstNonEmptyCommandString(_ candidates: [String?]) -> String? {
        for candidate in candidates {
            guard let candidate else { continue }
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed
            }
        }
        return nil
    }
}
