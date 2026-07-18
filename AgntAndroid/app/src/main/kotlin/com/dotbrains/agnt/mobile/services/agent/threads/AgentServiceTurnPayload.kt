package com.dotbrains.agnt.mobile.services.agent.threads

import com.dotbrains.agnt.mobile.core.error.AgentServiceError
import com.dotbrains.agnt.mobile.core.model.CodexCollaborationModeKind
import com.dotbrains.agnt.mobile.core.model.CodexImageAttachment
import com.dotbrains.agnt.mobile.core.model.CodexTurnMention
import com.dotbrains.agnt.mobile.core.model.CodexTurnSkillMention
import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.services.agent.AgentService
import com.dotbrains.agnt.mobile.services.agent.runtime.TurnStartEffortWireMode
import com.dotbrains.agnt.mobile.services.agent.runtime.runtimeModelIdentifierForTurn
import com.dotbrains.agnt.mobile.services.agent.runtime.selectedReasoningEffortForSelectedModel

internal fun AgentService.buildTurnStartRequestParams(
    threadId: String,
    userText: String,
    attachments: List<CodexImageAttachment>,
    skillMentions: List<CodexTurnSkillMention>,
    fileMentions: List<CodexTurnMention>,
    includeStructuredSkillItems: Boolean,
    includeStructuredMentionItems: Boolean,
    imageUrlKey: String,
    collaborationMode: CodexCollaborationModeKind?,
    includesServiceTier: Boolean,
    effortWireMode: TurnStartEffortWireMode?,
): JSONValue.Obj {
    val params = linkedMapOf<String, JSONValue>()
    params["threadId"] = JSONValue.Str(threadId)
    params["input"] =
        JSONValue.Arr(
            makeTurnInputPayload(
                userText = userText,
                attachments = attachments,
                imageUrlKey = imageUrlKey,
                skillMentions = skillMentions,
                fileMentions = fileMentions,
                includeStructuredSkillItems = includeStructuredSkillItems,
                includeStructuredMentionItems = includeStructuredMentionItems,
            ),
        )

    val threadModel = runtimeModelIdentifierForTurn(threadId)
    if (threadModel != null) {
        params["model"] = JSONValue.Str(threadModel)
    }
    val reasoningEffort = selectedReasoningEffortForSelectedModel()
    when (effortWireMode) {
        TurnStartEffortWireMode.UseEffort ->
            reasoningEffort?.let { params["effort"] = JSONValue.Str(it) }
        TurnStartEffortWireMode.UseReasoningEffort ->
            reasoningEffort?.let { params["reasoningEffort"] = JSONValue.Str(it) }
        null -> Unit
    }
    if (includesServiceTier) {
        _selectedServiceTier.value?.let { params["serviceTier"] = JSONValue.Str(it.name) }
    }
    if (collaborationMode != null) {
        params["collaborationMode"] =
            buildCollaborationModePayload(
                collaborationMode,
                threadModel,
                selectedReasoningEffortForSelectedModel(),
            )
    }

    return JSONValue.Obj(params)
}

// Builds the on-the-wire `params.collaborationMode` payload sent on `turn/start`.
//
// Producer parity:
//   * Codex transport reads this nested shape directly.
//   * Claude bridge translator
//     (agnt-bridge/src/providers/claude/translate.js) checks
//     `params.collaborationMode.mode === "plan"` and maps it to
//     `--permission-mode plan` - that's how plan mode reaches Claude today.
//   * Cursor / opencode read `permissionMode` separately; they ignore
//     `collaborationMode` so plan mode is effectively a no-op there
//     (which is correct - neither provider has a plan-mode equivalent).
//
// `internal` so JVM unit tests can pin the wire shape without spinning up a
// AgentService instance.
internal fun buildCollaborationModePayload(
    mode: CodexCollaborationModeKind,
    threadModel: String?,
    reasoningEffort: String?,
): JSONValue.Obj {
    if (mode == CodexCollaborationModeKind.plan && threadModel.isNullOrBlank()) {
        throw AgentServiceError.InvalidInput("Plan mode requires an available model before starting a plan turn.")
    }

    val settings = linkedMapOf<String, JSONValue>()
    if (!threadModel.isNullOrBlank()) {
        settings["model"] = JSONValue.Str(threadModel)
    }
    settings["reasoning_effort"] = reasoningEffort?.let { JSONValue.Str(it) } ?: JSONValue.Null
    settings["developer_instructions"] = JSONValue.Null

    return JSONValue.Obj(
        mapOf(
            "mode" to JSONValue.Str(mode.name),
            "settings" to JSONValue.Obj(settings),
        ),
    )
}

internal fun makeTurnInputPayload(
    userText: String,
    attachments: List<CodexImageAttachment>,
    imageUrlKey: String,
    skillMentions: List<CodexTurnSkillMention> = emptyList(),
    fileMentions: List<CodexTurnMention> = emptyList(),
    includeStructuredSkillItems: Boolean = true,
    includeStructuredMentionItems: Boolean = true,
): List<JSONValue> {
    val inputItems = ArrayList<JSONValue>()
    attachments.forEach { attachment ->
        val payloadDataUrl = attachment.payloadDataURL?.trim().orEmpty()
        if (payloadDataUrl.isEmpty()) return@forEach
        inputItems +=
            JSONValue.Obj(
                mapOf(
                    "type" to JSONValue.Str("image"),
                    imageUrlKey to JSONValue.Str(payloadDataUrl),
                ),
            )
    }
    val trimmedText = userText.trim()
    if (trimmedText.isNotEmpty()) {
        inputItems +=
            JSONValue.Obj(
                mapOf(
                    "type" to JSONValue.Str("text"),
                    "text" to JSONValue.Str(trimmedText),
                ),
            )
    }
    if (includeStructuredSkillItems) {
        skillMentions.forEach { mention ->
            val id = mention.id.trim()
            if (id.isEmpty()) return@forEach
            val payload = linkedMapOf<String, JSONValue>("type" to JSONValue.Str("skill"), "id" to JSONValue.Str(id))
            mention.name
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
                ?.let { payload["name"] = JSONValue.Str(it) }
            mention.path
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
                ?.let { payload["path"] = JSONValue.Str(it) }
            inputItems += JSONValue.Obj(payload)
        }
    }
    if (includeStructuredMentionItems) {
        fileMentions.forEach { mention ->
            val name = mention.name.trim()
            val path = mention.path.trim()
            if (name.isEmpty() || path.isEmpty()) return@forEach
            inputItems +=
                JSONValue.Obj(
                    mapOf(
                        "type" to JSONValue.Str("mention"),
                        "name" to JSONValue.Str(name),
                        "path" to JSONValue.Str(path),
                    ),
                )
        }
    }
    return inputItems
}

internal fun shouldRetryTurnStartWithoutSkillItems(error: Throwable): Boolean {
    val rpcFailure = error as? AgentServiceError.RpcFailure ?: return false
    val code = rpcFailure.rpcError.code
    if (code != -32600 && code != -32602) return false
    val message = rpcFailure.rpcError.message.lowercase()
    if (!message.contains("skill")) return false
    return message.contains("unknown") ||
        message.contains("unsupported") ||
        message.contains("invalid") ||
        message.contains("unexpected") ||
        message.contains("unrecognized") ||
        message.contains("failed to parse") ||
        message.contains("missing field") ||
        message.contains("expected")
}

internal fun shouldRetryTurnStartWithoutMentionItems(error: Throwable): Boolean {
    val rpcFailure = error as? AgentServiceError.RpcFailure ?: return false
    val code = rpcFailure.rpcError.code
    if (code != -32600 && code != -32602) return false
    val message = rpcFailure.rpcError.message.lowercase()
    if (!message.contains("mention")) return false
    return message.contains("unknown") ||
        message.contains("unsupported") ||
        message.contains("invalid") ||
        message.contains("unexpected") ||
        message.contains("unrecognized") ||
        message.contains("failed to parse") ||
        message.contains("missing field") ||
        message.contains("expected")
}

internal fun shouldRetryTurnStartWithImageURLField(error: Throwable): Boolean {
    val rpcFailure = error as? AgentServiceError.RpcFailure ?: return false
    val message = rpcFailure.rpcError.message.lowercase()
    if (!message.contains("image_url")) return false
    return message.contains("missing") ||
        message.contains("unknown field") ||
        message.contains("expected") ||
        message.contains("invalid")
}

internal fun shouldRetryTurnStartWithoutCollaborationMode(error: Throwable): Boolean {
    val rpcFailure = error as? AgentServiceError.RpcFailure ?: return false
    val code = rpcFailure.rpcError.code
    if (code != -32600 && code != -32602) return false
    val message = rpcFailure.rpcError.message.lowercase()
    if (!message.contains("collaboration")) return false
    return message.contains("missing") ||
        message.contains("unknown field") ||
        message.contains("unexpected") ||
        message.contains("unrecognized") ||
        message.contains("unsupported") ||
        message.contains("invalid")
}
