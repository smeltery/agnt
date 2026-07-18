// FILE: CodexService+History.swift
// Purpose: Parses thread/read history payloads into normalized timeline messages.
// Layer: Service
// Exports: CodexService history parsing helpers
// Depends on: CodexMessage, JSONValue

import Foundation

extension CodexService {
    // Decodes app-server turn arrays into a chronological message timeline.
    func decodeMessagesFromThreadRead(threadId: String, threadObject: [String: JSONValue]) -> [CodexMessage] {
        let baseDate = decodeHistoryBaseDate(from: threadObject, threadId: threadId)
        let threadTimeZoneIdentifier = decodeHistoryTimeZoneIdentifier(from: threadObject)
        let turns = threadObject["turns"]?.arrayValue ?? []

        var offset: TimeInterval = 0
        var result: [CodexMessage] = []

        for turnValue in turns {
            guard let turnObject = turnValue.objectValue else { continue }
            let turnID = historyTurnID(from: turnObject)
            let turnTimestamp = decodeHistoryTimestamp(from: turnObject)
            let turnTimeZoneIdentifier = decodeHistoryTimeZoneIdentifier(from: turnObject)
                ?? threadTimeZoneIdentifier
            let turnCompleted = historyTurnTerminalState(turnObject) == .completed
            let items = turnObject["items"]?.arrayValue ?? []

            for itemValue in items {
                guard let itemObject = itemValue.objectValue,
                      let itemType = itemObject["type"]?.stringValue else {
                    continue
                }

                let syntheticTimestamp = (turnTimestamp ?? baseDate).addingTimeInterval(offset)
                let timestamp = decodeHistoryTimestamp(from: itemObject) ?? syntheticTimestamp
                let timeZoneIdentifier = decodeHistoryTimeZoneIdentifier(from: itemObject)
                    ?? turnTimeZoneIdentifier
                offset += 0.001
                let itemID = itemObject["id"]?.stringValue
                let decodedText = decodeItemText(from: itemObject)
                let skillMentions = decodeHistorySkillMentions(from: itemObject)
                let pluginMentions = decodeHistoryPluginMentions(from: itemObject)
                let imageAttachments = decodeImageAttachments(from: itemObject)

                switch normalizedItemType(itemType) {
                case "usermessage":
                    appendHistoryMessage(
                        to: &result,
                        role: .user,
                        text: decodedText,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier,
                        skillMentions: skillMentions,
                        pluginMentions: pluginMentions,
                        attachments: imageAttachments
                    )

                case "agentmessage", "assistantmessage":
                    appendHistoryMessage(
                        to: &result,
                        role: .assistant,
                        kind: .chat,
                        assistantPhase: normalizedAssistantPhase(itemObject["phase"]?.stringValue),
                        text: decodedText,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier,
                        attachments: imageAttachments
                    )

                case "message":
                    let role = itemObject["role"]?.stringValue?.lowercased() ?? ""
                    let mappedRole: CodexMessageRole = role.contains("user") ? .user : .assistant

                    appendHistoryMessage(
                        to: &result,
                        role: mappedRole,
                        kind: .chat,
                        assistantPhase: mappedRole == .assistant
                            ? normalizedAssistantPhase(itemObject["phase"]?.stringValue)
                            : nil,
                        text: decodedText,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier,
                        skillMentions: mappedRole == .user ? skillMentions : [],
                        pluginMentions: mappedRole == .user ? pluginMentions : [],
                        attachments: imageAttachments
                    )

                case "imagegeneration", "imagegenerationcall", "imagegenerationend", "imageview":
                    guard let generatedImageText = decodeGeneratedImageMarkdown(from: itemObject) else {
                        continue
                    }
                    appendHistoryMessage(
                        to: &result,
                        role: .assistant,
                        kind: .chat,
                        text: generatedImageText,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "reasoning":
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: .thinking,
                        text: decodeReasoningItemText(from: itemObject),
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "filechange":
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: .fileChange,
                        text: decodeFileChangeItemText(from: itemObject),
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "toolcall":
                    guard let decodedToolCall = decodeHistoryToolCallItem(from: itemObject) else { continue }
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: decodedToolCall.kind,
                        text: decodedToolCall.text,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "diff":
                    guard let decodedFileChangeText = decodeHistoryDiffItemText(from: itemObject) else { continue }
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: .fileChange,
                        text: decodedFileChangeText,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "commandexecution":
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: .commandExecution,
                        text: decodeCommandExecutionItemText(from: itemObject),
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "enteredreviewmode":
                    let normalizedReviewLabel = decodeHistoryFirstString(
                        forAnyKey: ["review"],
                        in: .object(itemObject)
                    ) ?? "changes"
                    let message = "Reviewing \(normalizedReviewLabel)..."
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: .commandExecution,
                        text: message,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "exitedreviewmode":
                    guard let reviewText = decodeHistoryFirstString(
                        forAnyKey: ["review"],
                        in: .object(itemObject)
                    ) else { continue }
                    appendHistoryMessage(
                        to: &result,
                        role: .assistant,
                        kind: .chat,
                        assistantPhase: normalizedAssistantPhase(itemObject["phase"]?.stringValue),
                        text: reviewText,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "contextcompaction":
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: .commandExecution,
                        text: "Context compacted",
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "plan", "todolist":
                    let decodedPlanState = decodePlanState(from: itemObject)
                    let decodedPlanText = decodePlanItemText(from: itemObject)
                    guard CodexPlanUpdateVisibilityPolicy.shouldApply(
                        text: decodedPlanText,
                        planState: decodedPlanState
                    ) else {
                        continue
                    }
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: .plan,
                        text: decodedPlanText,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier,
                        planState: finalizedHistoryPlanState(decodedPlanState, turnCompleted: turnCompleted),
                        planPresentation: itemID == nil
                            ? .progress
                            : (turnCompleted ? .resultReady : .resultClosed)
                    )

                case let collabType where collabType == "collabagenttoolcall"
                    || collabType == "collabtoolcall"
                    || collabType.hasPrefix("collabagentspawn")
                    || collabType.hasPrefix("collabwaiting")
                    || collabType.hasPrefix("collabclose")
                    || collabType.hasPrefix("collabresume")
                    || collabType.hasPrefix("collabagentinteraction"):
                    guard let subagentAction = decodeSubagentActionItem(from: itemObject) else {
                        continue
                    }
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: .subagentAction,
                        text: subagentAction.summaryText,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier,
                        subagentAction: subagentAction
                    )

                default:
                    continue
                }
            }
        }

        return Self.historyMessagesMergingGeneratedImageArtifacts(result)
    }

    // Extracts persisted turn outcomes from canonical history so render grouping survives app relaunch.
    func decodeTurnTerminalStatesFromThreadRead(_ threadObject: [String: JSONValue]) -> [String: CodexTurnTerminalState] {
        let turns = threadObject["turns"]?.arrayValue ?? []
        var result: [String: CodexTurnTerminalState] = [:]

        for turnValue in turns {
            guard let turnObject = turnValue.objectValue,
                  let turnID = historyTurnID(from: turnObject),
                  !turnID.isEmpty,
                  let terminalState = historyTurnTerminalState(turnObject) else {
                continue
            }
            result[turnID] = terminalState
        }

        return result
    }



}
