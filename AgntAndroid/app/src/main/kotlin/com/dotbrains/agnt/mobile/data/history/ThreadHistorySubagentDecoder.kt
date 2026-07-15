package com.dotbrains.agnt.mobile.data.history

import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.CodexMessageRole
import com.dotbrains.agnt.mobile.core.model.CodexSubagentAction
import com.dotbrains.agnt.mobile.core.model.CodexSubagentRef
import com.dotbrains.agnt.mobile.core.model.CodexSubagentState
import com.dotbrains.agnt.mobile.core.model.JSONValue

internal fun isSubagentHistoryItemType(norm: String): Boolean =
    norm == "collabagenttoolcall" ||
        norm == "collabtoolcall" ||
        norm.startsWith("collabagentspawn") ||
        norm.startsWith("collabwaiting") ||
        norm.startsWith("collabclose") ||
        norm.startsWith("collabresume") ||
        norm.startsWith("collabagentinteraction")

internal fun decodeSubagentHistoryActionItem(itemObject: Map<String, JSONValue>): CodexSubagentAction? {
    val receiverThreadIds = decodeSubagentReceiverThreadIds(itemObject)
    val receiverAgents = decodeSubagentReceiverAgents(itemObject, receiverThreadIds)
    val agentStates = decodeSubagentAgentStates(itemObject)
    val tool = firstHistoryStringValue(itemObject, "tool", "name") ?: inferSubagentToolFromType(itemObject) ?: "spawnAgent"
    val status = firstHistoryStringValue(itemObject, "status") ?: "in_progress"
    val prompt = firstHistoryStringValue(itemObject, "prompt", "task", "message")
    val model =
        normalizedHistoryIdentifier(
            firstHistoryStringValue(
                itemObject,
                "model",
                "modelName",
                "model_name",
                "requestedModel",
                "requested_model",
            ),
        )

    if (receiverThreadIds.isEmpty() && receiverAgents.isEmpty() && agentStates.isEmpty() && prompt == null && model == null) {
        return null
    }

    return CodexSubagentAction(
        tool = tool,
        status = status,
        prompt = prompt,
        model = model,
        receiverThreadIds = receiverThreadIds,
        receiverAgents = receiverAgents,
        agentStates = agentStates,
    )
}

private fun decodeSubagentReceiverThreadIds(itemObject: Map<String, JSONValue>): List<String> {
    val plural =
        firstHistoryValue(itemObject, "receiverThreadIds", "receiver_thread_ids", "threadIds", "thread_ids")
            ?.arrayValue
            .orEmpty()
            .mapNotNull { normalizedHistoryIdentifier(it.stringValue) }
            .distinct()
    if (plural.isNotEmpty()) return plural

    return listOfNotNull(
        normalizedHistoryIdentifier(
            firstHistoryStringValue(
                itemObject,
                "receiverThreadId",
                "receiver_thread_id",
                "threadId",
                "thread_id",
                "newThreadId",
                "new_thread_id",
            ),
        ),
    )
}

private fun decodeSubagentReceiverAgents(
    itemObject: Map<String, JSONValue>,
    fallbackThreadIds: List<String>,
): List<CodexSubagentRef> {
    val values = firstHistoryValue(itemObject, "receiverAgents", "receiver_agents", "agents")?.arrayValue
    if (values.isNullOrEmpty()) return buildSyntheticAgentRefs(itemObject, fallbackThreadIds)

    return values.mapIndexedNotNull { index, value ->
        val obj = value.objectValue ?: return@mapIndexedNotNull null
        val threadId =
            normalizedHistoryIdentifier(
                firstHistoryStringValue(
                    obj,
                    "threadId",
                    "thread_id",
                    "receiverThreadId",
                    "receiver_thread_id",
                    "newThreadId",
                    "new_thread_id",
                ) ?: fallbackThreadIds.getOrNull(index),
            ) ?: return@mapIndexedNotNull null
        CodexSubagentRef(
            threadId = threadId,
            agentId =
                normalizedHistoryIdentifier(
                    firstHistoryStringValue(obj, "agentId", "agent_id", "receiverAgentId", "receiver_agent_id", "newAgentId", "new_agent_id", "id"),
                ),
            nickname =
                normalizedHistoryIdentifier(
                    firstHistoryStringValue(
                        obj,
                        "agentNickname",
                        "agent_nickname",
                        "receiverAgentNickname",
                        "receiver_agent_nickname",
                        "newAgentNickname",
                        "new_agent_nickname",
                        "nickname",
                        "name",
                    ),
                ),
            role =
                normalizedHistoryIdentifier(
                    firstHistoryStringValue(
                        obj,
                        "agentRole",
                        "agent_role",
                        "receiverAgentRole",
                        "receiver_agent_role",
                        "newAgentRole",
                        "new_agent_role",
                        "agentType",
                        "agent_type",
                    ),
                ),
            model =
                normalizedHistoryIdentifier(
                    firstHistoryStringValue(obj, "modelProvider", "model_provider", "modelProviderId", "model_provider_id", "modelName", "model_name", "model"),
                ),
            prompt = normalizedHistoryIdentifier(firstHistoryStringValue(obj, "prompt", "instructions", "instruction", "task", "message")),
        )
    }
}

private fun decodeSubagentAgentStates(itemObject: Map<String, JSONValue>): Map<String, CodexSubagentState> {
    val candidate = firstHistoryValue(itemObject, "statuses", "agentsStates", "agents_states", "agentStates", "agent_states")
    candidate?.objectValue?.let { obj ->
        val decoded = LinkedHashMap<String, CodexSubagentState>()
        for ((rawThreadId, value) in obj) {
            val stateObject = value.objectValue
            val threadId =
                normalizedHistoryIdentifier(rawThreadId)
                    ?: normalizedHistoryIdentifier(firstHistoryStringValue(stateObject, "threadId", "thread_id"))
                    ?: continue
            decoded[threadId] =
                CodexSubagentState(
                    threadId = threadId,
                    status = firstHistoryStringValue(stateObject, "status") ?: "unknown",
                    message = firstHistoryStringValue(stateObject, "message", "text", "delta", "summary"),
                )
        }
        return decoded
    }
    candidate?.arrayValue?.let { values ->
        val decoded = LinkedHashMap<String, CodexSubagentState>()
        for (value in values) {
            val obj = value.objectValue ?: continue
            val threadId = normalizedHistoryIdentifier(firstHistoryStringValue(obj, "threadId", "thread_id")) ?: continue
            decoded[threadId] =
                CodexSubagentState(
                    threadId = threadId,
                    status = firstHistoryStringValue(obj, "status") ?: "unknown",
                    message = firstHistoryStringValue(obj, "message", "text", "delta", "summary"),
                )
        }
        return decoded
    }
    return emptyMap()
}

private fun buildSyntheticAgentRefs(
    itemObject: Map<String, JSONValue>,
    fallbackThreadIds: List<String>,
): List<CodexSubagentRef> {
    val threadId =
        fallbackThreadIds.firstOrNull()
            ?: normalizedHistoryIdentifier(
                firstHistoryStringValue(
                    itemObject,
                    "receiverThreadId",
                    "receiver_thread_id",
                    "threadId",
                    "thread_id",
                    "newThreadId",
                    "new_thread_id",
                ),
            )
            ?: return emptyList()
    return listOf(
        CodexSubagentRef(
            threadId = threadId,
            agentId = normalizedHistoryIdentifier(firstHistoryStringValue(itemObject, "newAgentId", "new_agent_id", "agentId", "agent_id")),
            nickname =
                normalizedHistoryIdentifier(
                    firstHistoryStringValue(
                        itemObject,
                        "newAgentNickname",
                        "new_agent_nickname",
                        "agentNickname",
                        "agent_nickname",
                        "receiverAgentNickname",
                        "receiver_agent_nickname",
                    ),
                ),
            role =
                normalizedHistoryIdentifier(
                    firstHistoryStringValue(
                        itemObject,
                        "receiverAgentRole",
                        "receiver_agent_role",
                        "newAgentRole",
                        "new_agent_role",
                        "agentRole",
                        "agent_role",
                        "agentType",
                        "agent_type",
                    ),
                ),
            model =
                normalizedHistoryIdentifier(
                    firstHistoryStringValue(
                        itemObject,
                        "modelProvider",
                        "model_provider",
                        "modelProviderId",
                        "model_provider_id",
                        "modelName",
                        "model_name",
                        "model",
                    ),
                ),
            prompt = normalizedHistoryIdentifier(firstHistoryStringValue(itemObject, "prompt", "instructions", "instruction", "task", "message")),
        ),
    )
}

private fun inferSubagentToolFromType(itemObject: Map<String, JSONValue>): String? {
    val normalized = firstHistoryStringValue(itemObject, "type")?.let(::normalizedHistoryItemType) ?: return null
    return when {
        "spawn" in normalized -> "spawnAgent"
        "waiting" in normalized || "wait" in normalized -> "wait"
        "close" in normalized -> "closeAgent"
        "resume" in normalized -> "resumeAgent"
        "sendinput" in normalized || "interaction" in normalized -> "sendInput"
        else -> null
    }
}

internal fun foldSubagentAssistantSummaries(messages: List<CodexMessage>): List<CodexMessage> {
    if (messages.none { it.kind == CodexMessageKind.subagentAction }) return messages
    val out = messages.toMutableList()
    val summaryByTurn = LinkedHashMap<String, List<CodexSubagentRef>>()
    val allRefs = ArrayList<CodexSubagentRef>()
    out
        .filter { it.role == CodexMessageRole.assistant && it.kind == CodexMessageKind.chat }
        .forEach { message ->
            val refs = parseAssistantSubagentSummaryRefs(message.text)
            if (refs.isEmpty()) return@forEach
            allRefs += refs
            message.turnId?.let { summaryByTurn[it] = refs }
        }
    if (summaryByTurn.isEmpty() && allRefs.isEmpty()) return messages

    for (index in out.indices) {
        val message = out[index]
        val action = message.subagentAction ?: continue
        val refs =
            summaryByTurn[message.turnId]
                ?: allRefs.filter { ref ->
                    action.agentRows.any { it.threadId == ref.threadId || it.agentId == ref.agentId }
                }
        if (refs.isEmpty()) continue
        val enriched = enrichSubagentAction(action, refs)
        out[index] = message.copy(text = enriched.summaryText, subagentAction = enriched)
    }
    return out.filterNot { message ->
        message.role == CodexMessageRole.assistant &&
            message.kind == CodexMessageKind.chat &&
            parseAssistantSubagentSummaryRefs(message.text).isNotEmpty()
    }
}

private fun enrichSubagentAction(
    action: CodexSubagentAction,
    summaryRefs: List<CodexSubagentRef>,
): CodexSubagentAction {
    if (summaryRefs.isEmpty()) return action
    val refsByThread = summaryRefs.associateBy { it.threadId }
    val enrichedAgents =
        action.agentRows.map { row ->
            val summary = refsByThread[row.threadId]
            if (summary == null) {
                CodexSubagentRef(
                    threadId = row.threadId,
                    agentId = row.agentId,
                    nickname = row.nickname,
                    role = row.role,
                    model = row.model,
                    prompt = row.prompt,
                )
            } else {
                CodexSubagentRef(
                    threadId = row.threadId,
                    agentId = row.agentId,
                    nickname = row.nickname ?: summary.nickname,
                    role = row.role ?: summary.role,
                    model = row.model,
                    prompt = row.prompt,
                )
            }
        }
    val existingThreads = enrichedAgents.mapTo(linkedSetOf()) { it.threadId }
    val extraRefs = summaryRefs.filterNot { it.threadId in existingThreads }
    return action.copy(
        receiverThreadIds = (action.receiverThreadIds + summaryRefs.map { it.threadId }).distinct(),
        receiverAgents = enrichedAgents + extraRefs,
    )
}

private fun parseAssistantSubagentSummaryRefs(text: String): List<CodexSubagentRef> {
    if (!text.contains("subagent", ignoreCase = true)) return emptyList()
    val refs = ArrayList<CodexSubagentRef>()
    val inlinePairRegex =
        Regex("""[-*]?\s*`?([A-Za-z][A-Za-z0-9_-]{1,40})`?\s*\(\s*`?([0-9a-fA-F]{8}-[0-9a-fA-F-]{12,})`?\s*\)""")
    inlinePairRegex.findAll(text.replace('\n', ' ')).forEach { match ->
        refs +=
            CodexSubagentRef(
                threadId = match.groupValues[2].trim(),
                nickname = match.groupValues[1].trim(),
            )
    }
    var pendingName: String? = null
    val bulletRegex = Regex("""^\s*[-*]\s*`?([^`(\n]+?)`?\s*$""")
    val inlineRegex = Regex("""^\s*[-*]\s*`?([^`(\n]+?)`?\s*\(?`?([0-9a-fA-F]{8}-[0-9a-fA-F-]{12,})`?\)?\s*$""")
    val idRegex = Regex("""`?([0-9a-fA-F]{8}-[0-9a-fA-F-]{12,})`?""")
    for (line in text.lines()) {
        val inline = inlineRegex.find(line)
        if (inline != null) {
            val name = inline.groupValues[1].trim().takeIf { it.isNotEmpty() }
            val threadId = inline.groupValues[2].trim()
            if (name != null) refs += CodexSubagentRef(threadId = threadId, nickname = name)
            pendingName = null
            continue
        }
        val bullet = bulletRegex.find(line)
        if (bullet != null) {
            pendingName = bullet.groupValues[1].trim().takeIf { it.isNotEmpty() }
            continue
        }
        val id =
            idRegex
                .find(line)
                ?.groupValues
                ?.getOrNull(1)
                ?.trim()
        val name = pendingName
        if (name != null && !id.isNullOrBlank()) {
            refs += CodexSubagentRef(threadId = id, nickname = name)
            pendingName = null
        }
    }
    return refs.distinctBy { it.threadId }
}
