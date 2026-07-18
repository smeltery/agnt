// FILE: CodexService+HistorySubagents.swift
// Purpose: Decodes history subagent action payloads and identity metadata.
// Layer: Service
// Exports: CodexService history subagent helpers
// Depends on: CodexSubagentAction, JSONValue

import Foundation

extension CodexService {
    // Parses collabAgentToolCall payloads into a stable summary row the timeline can render.
    func decodeSubagentActionItem(from itemObject: [String: JSONValue]) -> CodexSubagentAction? {
        ingestSubagentIdentityMetadata(from: itemObject)

        let receiverThreadIds = decodeSubagentReceiverThreadIDs(from: itemObject)
        let receiverAgents = decodeSubagentReceiverAgents(
            from: itemObject,
            fallbackThreadIds: receiverThreadIds
        )
        let agentStates = decodeSubagentAgentStates(from: itemObject)

        let rawTool = firstStringValue(in: itemObject, keys: ["tool", "name"])
        let tool = rawTool ?? inferToolFromEventType(itemObject) ?? "spawnAgent"
        let status = firstStringValue(in: itemObject, keys: ["status"]) ?? "in_progress"
        let prompt = firstStringValue(in: itemObject, keys: ["prompt", "task", "message"])
        let model = normalizedIdentifier(
            firstStringValue(
                in: itemObject,
                keys: ["model", "modelName", "model_name", "requestedModel", "requested_model"]
            )
        )

        guard !receiverThreadIds.isEmpty
            || !receiverAgents.isEmpty
            || !agentStates.isEmpty
            || prompt != nil
            || model != nil else {
            return nil
        }

        return CodexSubagentAction(
            tool: tool,
            status: status,
            prompt: prompt,
            model: model,
            receiverThreadIds: receiverThreadIds,
            receiverAgents: receiverAgents,
            agentStates: agentStates
        )
    }

    private func ingestSubagentIdentityMetadata(from itemObject: [String: JSONValue]) {
        func upsertIdentity(threadId: String?, agentId: String?, nickname: String?, role: String?) {
            upsertSubagentIdentity(
                threadId: threadId,
                agentId: agentId,
                nickname: nickname,
                role: role
            )
        }

        let extracted = extractSubagentIdentity(from: itemObject)
        upsertIdentity(
            threadId: extracted.threadId,
            agentId: extracted.agentId,
            nickname: extracted.nickname,
            role: extracted.role
        )

        upsertIdentity(
            threadId: firstStringValue(in: itemObject, keys: ["newThreadId", "new_thread_id"]),
            agentId: firstStringValue(in: itemObject, keys: ["newAgentId", "new_agent_id"]),
            nickname: firstStringValue(in: itemObject, keys: ["newAgentNickname", "new_agent_nickname"]),
            role: firstStringValue(in: itemObject, keys: ["newAgentRole", "new_agent_role"])
        )

        upsertIdentity(
            threadId: firstStringValue(in: itemObject, keys: ["receiverThreadId", "receiver_thread_id"]),
            agentId: firstStringValue(in: itemObject, keys: ["receiverAgentId", "receiver_agent_id"]),
            nickname: firstStringValue(in: itemObject, keys: ["receiverAgentNickname", "receiver_agent_nickname"]),
            role: firstStringValue(in: itemObject, keys: ["receiverAgentRole", "receiver_agent_role"])
        )

        let receiverThreadIds = decodeSubagentReceiverThreadIDs(from: itemObject)
        let receiverAgents = decodeSubagentReceiverAgents(from: itemObject, fallbackThreadIds: receiverThreadIds)
        for agent in receiverAgents {
            upsertIdentity(
                threadId: agent.threadId,
                agentId: agent.agentId,
                nickname: agent.nickname,
                role: agent.role
            )
        }

        if let statuses = firstValue(forAnyKey: ["statuses"], in: .object(itemObject))?.objectValue {
            for (threadId, rawStatus) in statuses {
                guard let statusObject = rawStatus.objectValue else { continue }
                upsertIdentity(
                    threadId: threadId,
                    agentId: firstStringValue(in: statusObject, keys: ["agentId", "agent_id"]),
                    nickname: firstStringValue(
                        in: statusObject,
                        keys: ["agentNickname", "agent_nickname", "receiverAgentNickname", "receiver_agent_nickname"]
                    ),
                    role: firstStringValue(
                        in: statusObject,
                        keys: ["agentRole", "agent_role", "receiverAgentRole", "receiver_agent_role", "agentType", "agent_type"]
                    )
                )
            }
        }

        if let statusEntries = firstValue(forAnyKey: ["agentStatuses", "agent_statuses"], in: .object(itemObject))?.arrayValue {
            for rawEntry in statusEntries {
                guard let entry = rawEntry.objectValue else { continue }
                upsertIdentity(
                    threadId: firstStringValue(in: entry, keys: ["threadId", "thread_id", "receiverThreadId", "receiver_thread_id"]),
                    agentId: firstStringValue(in: entry, keys: ["agentId", "agent_id"]),
                    nickname: firstStringValue(
                        in: entry,
                        keys: ["agentNickname", "agent_nickname", "receiverAgentNickname", "receiver_agent_nickname"]
                    ),
                    role: firstStringValue(
                        in: entry,
                        keys: ["agentRole", "agent_role", "receiverAgentRole", "receiver_agent_role", "agentType", "agent_type"]
                    )
                )
            }
        }
    }

    private func extractSubagentIdentity(from object: [String: JSONValue]) -> CodexSubagentIdentityEntry {
        let sourceObject = object["source"]?.objectValue
        let subAgentObject = sourceObject?["subAgent"]?.objectValue ?? sourceObject?["sub_agent"]?.objectValue
        let threadSpawnObject = subAgentObject?["thread_spawn"]?.objectValue ?? subAgentObject?["threadSpawn"]?.objectValue

        return CodexSubagentIdentityEntry(
            threadId: normalizedIdentifier(
                firstStringValue(
                    in: object,
                    keys: ["threadId", "thread_id", "conversationId", "conversation_id", "receiverThreadId", "receiver_thread_id"]
                )
            ) ?? normalizedIdentifier(firstStringValue(in: threadSpawnObject, keys: ["threadId", "thread_id"])),
            agentId: normalizedIdentifier(firstStringValue(in: object, keys: ["agentId", "agent_id", "id"]))
                ?? normalizedIdentifier(firstStringValue(in: threadSpawnObject, keys: ["agentId", "agent_id", "id"]))
                ?? normalizedIdentifier(firstStringValue(in: subAgentObject, keys: ["agentId", "agent_id", "id"])),
            nickname: normalizedIdentifier(
                firstStringValue(in: object, keys: ["agentNickname", "agent_nickname", "nickname"])
            ) ?? normalizedIdentifier(firstStringValue(in: threadSpawnObject, keys: ["agentNickname", "agent_nickname", "nickname", "name"]))
                ?? normalizedIdentifier(firstStringValue(in: subAgentObject, keys: ["agentNickname", "agent_nickname", "nickname", "name"])),
            role: normalizedIdentifier(
                firstStringValue(in: object, keys: ["agentRole", "agent_role", "agentType", "agent_type"])
            ) ?? normalizedIdentifier(firstStringValue(in: threadSpawnObject, keys: ["agentRole", "agent_role", "agentType", "agent_type"]))
                ?? normalizedIdentifier(firstStringValue(in: subAgentObject, keys: ["agentRole", "agent_role", "agentType", "agent_type"]))
        )
    }

    // Infers the collab tool type from the event's `type` field when `tool` is missing.
    private func inferToolFromEventType(_ itemObject: [String: JSONValue]) -> String? {
        guard let rawType = firstStringValue(in: itemObject, keys: ["type"]) else { return nil }
        let normalized = rawType.lowercased()
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")

        if normalized.contains("spawn") { return "spawnAgent" }
        if normalized.contains("waiting") || normalized.contains("wait") { return "wait" }
        if normalized.contains("close") { return "closeAgent" }
        if normalized.contains("resume") { return "resumeAgent" }
        if normalized.contains("sendinput") || normalized.contains("interaction") { return "sendInput" }
        return nil
    }

    func decodeNormalizedPlanText(_ value: JSONValue?) -> String? {
        let flattened = decodeHistoryStringParts(value).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !flattened.isEmpty else {
            return nil
        }
        return flattened
    }

    private func decodeSubagentReceiverThreadIDs(from itemObject: [String: JSONValue]) -> [String] {
        // Try plural array first.
        let candidate = firstValue(
            forAnyKey: ["receiverThreadIds", "receiver_thread_ids", "threadIds", "thread_ids"],
            in: .object(itemObject)
        )
        if let values = candidate?.arrayValue {
            var threadIds: [String] = []
            for value in values {
                if let threadId = normalizedIdentifier(value.stringValue),
                   !threadIds.contains(threadId) {
                    threadIds.append(threadId)
                }
            }
            if !threadIds.isEmpty { return threadIds }
        }

        // Fallback: singular top-level field (Codex CLI sends one event per agent).
        if let singularId = normalizedIdentifier(
            firstStringValue(
                in: itemObject,
                keys: [
                    "receiverThreadId", "receiver_thread_id",
                    "threadId", "thread_id",
                    "newThreadId", "new_thread_id",
                ]
            )
        ) {
            return [singularId]
        }

        return []
    }

    private func decodeSubagentReceiverAgents(
        from itemObject: [String: JSONValue],
        fallbackThreadIds: [String]
    ) -> [CodexSubagentRef] {
        let candidate = firstValue(
            forAnyKey: ["receiverAgents", "receiver_agents", "agents"],
            in: .object(itemObject)
        )
        if candidate?.arrayValue == nil || candidate?.arrayValue?.isEmpty == true {
            // Codex CLI sends singular top-level identity fields per event.
            return buildSyntheticAgentRefs(from: itemObject, fallbackThreadIds: fallbackThreadIds)
        }
        let values = candidate!.arrayValue!

        return values.enumerated().compactMap { index, value in
            guard let object = value.objectValue else { return nil }

            let fallbackThreadId = index < fallbackThreadIds.count ? fallbackThreadIds[index] : nil
            let threadId = normalizedIdentifier(
                firstStringValue(
                    in: object,
                    keys: [
                        "threadId", "thread_id",
                        "receiverThreadId", "receiver_thread_id",
                        "newThreadId", "new_thread_id",
                    ]
                ) ?? fallbackThreadId
            )
            guard let threadId else { return nil }

            return CodexSubagentRef(
                threadId: threadId,
                agentId: normalizedIdentifier(
                    firstStringValue(
                        in: object,
                        keys: [
                            "agentId", "agent_id",
                            "receiverAgentId", "receiver_agent_id",
                            "newAgentId", "new_agent_id",
                            "id",
                        ]
                    )
                ),
                nickname: normalizedIdentifier(
                    firstStringValue(
                        in: object,
                        keys: [
                            "agentNickname", "agent_nickname",
                            "receiverAgentNickname", "receiver_agent_nickname",
                            "newAgentNickname", "new_agent_nickname",
                            "nickname", "name",
                        ]
                    )
                ),
                role: normalizedIdentifier(
                    firstStringValue(
                        in: object,
                        keys: [
                            "agentRole", "agent_role",
                            "receiverAgentRole", "receiver_agent_role",
                            "newAgentRole", "new_agent_role",
                            "agentType", "agent_type",
                        ]
                    )
                ),
                model: normalizedIdentifier(
                    firstStringValue(
                        in: object,
                        keys: [
                            "modelProvider", "model_provider",
                            "modelProviderId", "model_provider_id",
                            "modelName", "model_name",
                            "model",
                        ]
                    )
                ),
                prompt: normalizedIdentifier(
                    firstStringValue(
                        in: object,
                        keys: ["prompt", "instructions", "instruction", "task", "message"]
                    )
                )
            )
        }
    }

    private func decodeSubagentAgentStates(from itemObject: [String: JSONValue]) -> [String: CodexSubagentState] {
        let candidate = firstValue(
            forAnyKey: ["statuses", "agentsStates", "agents_states", "agentStates", "agent_states"],
            in: .object(itemObject)
        )

        if let object = candidate?.objectValue {
            var decoded: [String: CodexSubagentState] = [:]
            for (rawThreadId, value) in object {
                let stateObject = value.objectValue
                let threadId = normalizedIdentifier(rawThreadId)
                    ?? normalizedIdentifier(firstStringValue(in: stateObject, keys: ["threadId", "thread_id"]))
                guard let threadId else { continue }

                decoded[threadId] = CodexSubagentState(
                    threadId: threadId,
                    status: firstStringValue(in: stateObject, keys: ["status"]) ?? "unknown",
                    message: firstStringValue(in: stateObject, keys: ["message", "text", "delta", "summary"])
                )
            }
            return decoded
        }

        if let values = candidate?.arrayValue {
            var decoded: [String: CodexSubagentState] = [:]
            for value in values {
                guard let object = value.objectValue,
                      let threadId = normalizedIdentifier(firstStringValue(in: object, keys: ["threadId", "thread_id"])) else {
                    continue
                }

                decoded[threadId] = CodexSubagentState(
                    threadId: threadId,
                    status: firstStringValue(in: object, keys: ["status"]) ?? "unknown",
                    message: firstStringValue(in: object, keys: ["message", "text", "delta", "summary"])
                )
            }
            return decoded
        }

        return [:]
    }

    // Builds a single-element agent ref array from top-level fields when the Codex CLI sends
    // one event per agent with singular fields (new_agent_nickname, receiver_thread_id, etc.)
    // instead of a nested receiverAgents array.
    private func buildSyntheticAgentRefs(
        from itemObject: [String: JSONValue],
        fallbackThreadIds: [String]
    ) -> [CodexSubagentRef] {
        guard let threadId = fallbackThreadIds.first
            ?? normalizedIdentifier(
                firstStringValue(
                    in: itemObject,
                    keys: [
                        "receiverThreadId", "receiver_thread_id",
                        "threadId", "thread_id",
                        "newThreadId", "new_thread_id",
                    ]
                )
            ) else {
            return []
        }

        let nickname = normalizedIdentifier(
            firstStringValue(
                in: itemObject,
                keys: [
                    "newAgentNickname", "new_agent_nickname",
                    "agentNickname", "agent_nickname",
                    "receiverAgentNickname", "receiver_agent_nickname",
                ]
            )
        )
        let role = normalizedIdentifier(
            firstStringValue(
                in: itemObject,
                keys: [
                    "receiverAgentRole", "receiver_agent_role",
                    "newAgentRole", "new_agent_role",
                    "agentRole", "agent_role",
                    "agentType", "agent_type",
                ]
            )
        )
        let agentId = normalizedIdentifier(
            firstStringValue(
                in: itemObject,
                keys: [
                    "newAgentId", "new_agent_id",
                    "agentId", "agent_id",
                ]
            )
        )
        let model = normalizedIdentifier(
            firstStringValue(
                in: itemObject,
                keys: [
                    "modelProvider", "model_provider",
                    "modelProviderId", "model_provider_id",
                    "modelName", "model_name",
                    "model",
                ]
            )
        )
        let prompt = normalizedIdentifier(
            firstStringValue(
                in: itemObject,
                keys: ["prompt", "instructions", "instruction", "task", "message"]
            )
        )

        return [CodexSubagentRef(
            threadId: threadId,
            agentId: agentId,
            nickname: nickname,
            role: role,
            model: model,
            prompt: prompt
        )]
    }

}
