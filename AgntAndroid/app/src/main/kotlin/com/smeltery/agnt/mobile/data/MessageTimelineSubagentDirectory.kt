package com.smeltery.agnt.mobile.data

import com.smeltery.agnt.mobile.core.model.CodexMessage
import com.smeltery.agnt.mobile.core.model.CodexMessageKind
import com.smeltery.agnt.mobile.core.model.CodexMessageRole
import com.smeltery.agnt.mobile.core.model.CodexSubagentAction
import com.smeltery.agnt.mobile.core.model.CodexSubagentRef
import com.smeltery.agnt.mobile.core.model.CodexSubagentState

internal class MessageTimelineSubagentDirectory {
    private data class SubagentIdentityEntry(
        val threadId: String? = null,
        val agentId: String? = null,
        val nickname: String? = null,
        val role: String? = null,
    ) {
        val hasMetadata: Boolean
            get() = threadId != null || agentId != null || nickname != null || role != null
    }

    private val identityByThreadId = mutableMapOf<String, SubagentIdentityEntry>()
    private val identityByAgentId = mutableMapOf<String, SubagentIdentityEntry>()

    fun rebuild(messages: List<CodexMessage>) {
        identityByThreadId.clear()
        identityByAgentId.clear()
        messages.forEach { message ->
            message.subagentAction?.let(::ingest)
            parseAssistantSummaryRefs(message.text).forEach { ref ->
                upsert(ref.threadId, ref.agentId, ref.nickname, ref.role)
            }
        }
    }

    fun upsert(
        threadId: String?,
        agentId: String?,
        nickname: String?,
        role: String?,
    ) {
        val normalizedThreadId = normalizedIdentifier(threadId)
        val normalizedAgentId = normalizedIdentifier(agentId)
        val normalizedNickname = normalizedIdentifier(nickname)
        val normalizedRole = normalizedIdentifier(role)
        if (normalizedThreadId == null && normalizedAgentId == null && normalizedNickname == null && normalizedRole == null) {
            return
        }
        val threadEntry = normalizedThreadId?.let { identityByThreadId[it] }
        val agentEntry = normalizedAgentId?.let { identityByAgentId[it] }
        val merged =
            SubagentIdentityEntry(
                threadId = normalizedThreadId ?: threadEntry?.threadId ?: agentEntry?.threadId,
                agentId = normalizedAgentId ?: threadEntry?.agentId ?: agentEntry?.agentId,
                nickname = normalizedNickname ?: threadEntry?.nickname ?: agentEntry?.nickname,
                role = normalizedRole ?: threadEntry?.role ?: agentEntry?.role,
            )
        if (!merged.hasMetadata) return
        normalizedThreadId?.let { identityByThreadId[it] = merged }
        normalizedAgentId?.let { identityByAgentId[it] = merged }
        merged.threadId?.let { tid ->
            merged.agentId?.let { aid ->
                identityByThreadId[tid] = merged
                identityByAgentId[aid] = merged
            }
        }
    }

    fun resolveMessage(message: CodexMessage): CodexMessage {
        val action = message.subagentAction ?: return message
        val resolvedAction = resolveAction(action)
        return if (resolvedAction == action) {
            message
        } else {
            message.copy(text = resolvedAction.summaryText, subagentAction = resolvedAction)
        }
    }

    fun resolveAction(action: CodexSubagentAction): CodexSubagentAction {
        ingest(action)
        val resolvedAgents =
            action.agentRows.map { agent ->
                val identity = resolvedIdentity(agent.threadId, agent.agentId)
                CodexSubagentRef(
                    threadId = identity?.threadId ?: agent.threadId,
                    agentId = identity?.agentId ?: agent.agentId,
                    nickname = identity?.nickname ?: agent.nickname,
                    role = identity?.role ?: agent.role,
                    model = agent.model,
                    prompt = agent.prompt,
                )
            }
        return action.copy(
            receiverThreadIds = (action.receiverThreadIds + resolvedAgents.map { it.threadId }).distinct(),
            receiverAgents = resolvedAgents,
        )
    }

    fun mergeActions(
        existing: CodexSubagentAction?,
        incoming: CodexSubagentAction,
    ): CodexSubagentAction {
        if (existing == null || existing.normalizedTool != incoming.normalizedTool) return incoming
        val receiverThreadIds = linkedSetOf<String>()
        receiverThreadIds.addAll(existing.receiverThreadIds)
        receiverThreadIds.addAll(incoming.receiverThreadIds)

        val receiverAgentsByThread = LinkedHashMap<String, CodexSubagentRef>()

        fun addAgent(agent: CodexSubagentRef) {
            val key = agent.threadId.trim()
            if (key.isEmpty()) return
            val current = receiverAgentsByThread[key]
            receiverAgentsByThread[key] =
                if (current == null) {
                    agent
                } else {
                    current.copy(
                        agentId = current.agentId ?: agent.agentId,
                        nickname = current.nickname ?: agent.nickname,
                        role = current.role ?: agent.role,
                        model = current.model ?: agent.model,
                        prompt = current.prompt ?: agent.prompt,
                    )
                }
        }
        existing.receiverAgents.forEach(::addAgent)
        incoming.receiverAgents.forEach(::addAgent)

        val agentStates = LinkedHashMap<String, CodexSubagentState>()
        agentStates.putAll(existing.agentStates)
        agentStates.putAll(incoming.agentStates)

        return incoming.copy(
            prompt = incoming.prompt ?: existing.prompt,
            model = incoming.model ?: existing.model,
            receiverThreadIds = receiverThreadIds.toList(),
            receiverAgents = receiverAgentsByThread.values.toList(),
            agentStates = agentStates,
        )
    }

    fun absorbAssistantSummary(
        list: MutableList<CodexMessage>,
        turnId: String?,
        text: String,
    ): Boolean {
        val refs = parseAssistantSummaryRefs(text)
        if (refs.isEmpty()) return false
        refs.forEach { ref -> upsert(ref.threadId, ref.agentId, ref.nickname, ref.role) }
        var changed = false
        for (index in list.indices) {
            val current = list[index]
            val action = current.subagentAction ?: continue
            val sameTurn = turnId != null && current.turnId == turnId
            val matchesThread =
                action.agentRows.any { agent -> refs.any { it.threadId == agent.threadId || it.agentId == agent.agentId } }
            if (!sameTurn && !matchesThread) continue
            val enriched = resolveAction(enrichAction(action, refs))
            list[index] = current.copy(text = enriched.summaryText, subagentAction = enriched)
            changed = true
        }
        return changed
    }

    fun summaryRefsForTurn(
        list: List<CodexMessage>,
        turnId: String?,
    ): List<CodexSubagentRef> {
        if (turnId.isNullOrBlank()) return emptyList()
        return list
            .asReversed()
            .firstOrNull { message ->
                message.role == CodexMessageRole.assistant &&
                    message.kind == CodexMessageKind.chat &&
                    message.turnId == turnId &&
                    parseAssistantSummaryRefs(message.text).isNotEmpty()
            }?.let { parseAssistantSummaryRefs(it.text) }
            .orEmpty()
    }

    fun removeAssistantSummaries(
        list: MutableList<CodexMessage>,
        turnId: String?,
    ) {
        if (turnId.isNullOrBlank()) return
        list.removeAll { message ->
            message.role == CodexMessageRole.assistant &&
                message.kind == CodexMessageKind.chat &&
                message.turnId == turnId &&
                parseAssistantSummaryRefs(message.text).isNotEmpty()
        }
    }

    fun enrichAction(
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

    private fun ingest(action: CodexSubagentAction) {
        action.agentRows.forEach { agent ->
            upsert(agent.threadId, agent.agentId, agent.nickname, agent.role)
        }
        action.receiverAgents.forEach { agent ->
            upsert(agent.threadId, agent.agentId, agent.nickname, agent.role)
        }
        action.agentStates.values.forEach { state ->
            upsert(threadId = state.threadId, agentId = null, nickname = null, role = null)
        }
    }

    private fun resolvedIdentity(
        threadId: String?,
        agentId: String?,
    ): SubagentIdentityEntry? {
        val threadEntry = normalizedIdentifier(threadId)?.let { identityByThreadId[it] }
        val agentEntry = normalizedIdentifier(agentId)?.let { identityByAgentId[it] }
        val merged =
            SubagentIdentityEntry(
                threadId = threadEntry?.threadId ?: agentEntry?.threadId,
                agentId = threadEntry?.agentId ?: agentEntry?.agentId,
                nickname = threadEntry?.nickname ?: agentEntry?.nickname,
                role = threadEntry?.role ?: agentEntry?.role,
            )
        return merged.takeIf { it.hasMetadata }
    }

    private fun normalizedIdentifier(value: String?): String? = value?.trim()?.takeIf { it.isNotEmpty() }

    private fun parseAssistantSummaryRefs(text: String): List<CodexSubagentRef> {
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
        val lines = text.lines()
        var pendingName: String? = null
        val bulletRegex = Regex("""^\s*[-*]\s*`?([^`(\n]+?)`?\s*$""")
        val inlineRegex = Regex("""^\s*[-*]\s*`?([^`(\n]+?)`?\s*\(?`?([0-9a-fA-F]{8}-[0-9a-fA-F-]{12,})`?\)?\s*$""")
        val idRegex = Regex("""`?([0-9a-fA-F]{8}-[0-9a-fA-F-]{12,})`?""")
        for (line in lines) {
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
            val name = pendingName
            val id =
                idRegex
                    .find(line)
                    ?.groupValues
                    ?.getOrNull(1)
                    ?.trim()
            if (name != null && !id.isNullOrBlank()) {
                refs += CodexSubagentRef(threadId = id, nickname = name)
                pendingName = null
            }
        }
        return refs.distinctBy { it.threadId }
    }
}
