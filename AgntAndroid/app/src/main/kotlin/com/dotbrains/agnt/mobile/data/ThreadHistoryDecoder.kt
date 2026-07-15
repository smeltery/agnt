package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.CodexImageAttachment
import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.CodexMessageRole
import com.dotbrains.agnt.mobile.core.model.CodexPlanState
import com.dotbrains.agnt.mobile.core.model.CodexSubagentAction
import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.data.history.DecodedCompletedItem
import com.dotbrains.agnt.mobile.data.history.decodeHistoryBaseInstant
import com.dotbrains.agnt.mobile.data.history.decodeHistoryInstant
import com.dotbrains.agnt.mobile.data.history.decodeHistoryPlanState
import com.dotbrains.agnt.mobile.data.history.decodeSubagentHistoryActionItem
import com.dotbrains.agnt.mobile.data.history.finalizedHistoryPlanState
import com.dotbrains.agnt.mobile.data.history.foldSubagentAssistantSummaries
import com.dotbrains.agnt.mobile.data.history.isCompletedHistoryTurn
import com.dotbrains.agnt.mobile.data.history.isSubagentHistoryItemType
import com.dotbrains.agnt.mobile.data.history.normalizedHistoryItemType
import com.dotbrains.agnt.mobile.data.history.sanitizeHistoryTextForKind
import java.time.Instant

/**
 * Decodes [thread/read] with includeTurns=true (parity with [AgentService.decodeMessagesFromThreadRead]).
 */
internal object ThreadHistoryDecoder {
    fun decodeFromThreadRead(
        threadId: String,
        threadObject: Map<String, JSONValue>,
    ): List<CodexMessage> {
        val base = decodeHistoryBaseInstant(threadObject)
        val turns = threadObject["turns"]?.arrayValue ?: return emptyList()
        var offset = 0.0
        val out = ArrayList<CodexMessage>()
        for (turnValue in turns) {
            val turnObject = turnValue.objectValue ?: continue
            val turnId = turnObject["id"]?.stringValue?.trim()?.takeIf { it.isNotEmpty() }
            val turnTs = decodeHistoryInstant(turnObject) ?: base
            val turnCompleted = isCompletedHistoryTurn(turnObject)
            val items = turnObject["items"]?.arrayValue ?: continue
            for (itemValue in items) {
                val itemObject = itemValue.objectValue ?: continue
                val itemType = itemObject["type"]?.stringValue ?: continue
                val synthetic = turnTs.plusMillis((offset * 1000).toLong())
                offset += 0.001
                val ts = decodeHistoryInstant(itemObject) ?: synthetic
                val itemId = itemObject["id"]?.stringValue?.trim()?.takeIf { it.isNotEmpty() }
                val text = decodeItemText(itemObject)
                val attachments = decodeImageAttachments(itemObject)
                val norm = normalizedHistoryItemType(itemType)
                when (norm) {
                    "usermessage" ->
                        append(out, threadId, CodexMessageRole.user, CodexMessageKind.chat, text, turnId, itemId, ts, attachments)
                    "agentmessage", "assistantmessage" ->
                        append(
                            out,
                            threadId,
                            CodexMessageRole.assistant,
                            CodexMessageKind.chat,
                            text,
                            turnId,
                            itemId,
                            ts,
                            attachments,
                            assistantPhase = IncomingNotificationParsers.extractAssistantPhase(null, itemObject),
                        )
                    "message" -> {
                        val roleRaw = itemObject["role"]?.stringValue?.lowercase().orEmpty()
                        val role =
                            if (roleRaw.contains("user")) CodexMessageRole.user else CodexMessageRole.assistant
                        append(
                            out,
                            threadId,
                            role,
                            CodexMessageKind.chat,
                            text,
                            turnId,
                            itemId,
                            ts,
                            attachments,
                            assistantPhase =
                                if (role == CodexMessageRole.assistant) {
                                    IncomingNotificationParsers.extractAssistantPhase(null, itemObject)
                                } else {
                                    null
                                },
                        )
                    }
                    "reasoning" ->
                        append(
                            out,
                            threadId,
                            CodexMessageRole.system,
                            CodexMessageKind.thinking,
                            decodeReasoningText(itemObject),
                            turnId,
                            itemId,
                            ts,
                        )
                    "filechange" ->
                        append(
                            out,
                            threadId,
                            CodexMessageRole.system,
                            CodexMessageKind.fileChange,
                            decodeFileChangeBody(itemObject),
                            turnId,
                            itemId,
                            ts,
                        )
                    "toolcall", "diff" -> {
                        val t = decodeToolOrDiffPreview(itemObject)
                        if (t.isNotEmpty()) {
                            append(
                                out,
                                threadId,
                                CodexMessageRole.system,
                                CodexMessageKind.fileChange,
                                t,
                                turnId,
                                itemId,
                                ts,
                            )
                        }
                    }
                    "commandexecution" ->
                        append(
                            out,
                            threadId,
                            CodexMessageRole.system,
                            CodexMessageKind.commandExecution,
                            decodeCommandPreview(itemObject),
                            turnId,
                            itemId,
                            ts,
                        )
                    "imagegeneration", "imagegenerationcall", "imagegenerationend", "imageview" -> {
                        val imageAttachments = decodeGeneratedImageAttachments(itemObject)
                        if (imageAttachments.isNotEmpty()) {
                            append(
                                out,
                                threadId,
                                CodexMessageRole.assistant,
                                CodexMessageKind.chat,
                                "",
                                turnId,
                                itemId,
                                ts,
                                imageAttachments,
                                assistantPhase = "final_answer",
                            )
                        }
                    }
                    "plan" ->
                        append(
                            out,
                            threadId,
                            CodexMessageRole.system,
                            CodexMessageKind.plan,
                            text.ifEmpty { "[plan]" },
                            turnId,
                            itemId,
                            ts,
                            planState = finalizedHistoryPlanState(decodeHistoryPlanState(itemObject), turnCompleted),
                        )
                    "contextcompaction" ->
                        append(
                            out,
                            threadId,
                            CodexMessageRole.system,
                            CodexMessageKind.commandExecution,
                            "Context compacted",
                            turnId,
                            itemId,
                            ts,
                        )
                    else -> {
                        if (isSubagentHistoryItemType(norm)) {
                            decodeSubagentHistoryActionItem(itemObject)?.let { action ->
                                append(
                                    out,
                                    threadId,
                                    CodexMessageRole.system,
                                    CodexMessageKind.subagentAction,
                                    action.summaryText,
                                    turnId,
                                    itemId,
                                    ts,
                                    subagentAction = action,
                                )
                            }
                        }
                    }
                }
            }
        }
        return foldSubagentAssistantSummaries(out)
    }

    /** `item/completed` payload (parity iOS `handleStructuredItemLifecycle` testi principali). */
    fun decodeCompletedItem(itemObject: Map<String, JSONValue>): DecodedCompletedItem? {
        val itemType = itemObject["type"]?.stringValue ?: return null
        val norm = normalizedHistoryItemType(itemType)
        return when (norm) {
            "usermessage" ->
                DecodedCompletedItem(
                    CodexMessageRole.user,
                    CodexMessageKind.chat,
                    sanitizeHistoryTextForKind(CodexMessageKind.chat, decodeItemText(itemObject)),
                    decodeImageAttachments(itemObject),
                )
            "agentmessage", "assistantmessage" ->
                DecodedCompletedItem(
                    CodexMessageRole.assistant,
                    CodexMessageKind.chat,
                    sanitizeHistoryTextForKind(CodexMessageKind.chat, decodeItemText(itemObject)),
                    decodeImageAttachments(itemObject),
                    assistantPhase = IncomingNotificationParsers.extractAssistantPhase(null, itemObject),
                )
            "message" -> {
                val roleRaw = itemObject["role"]?.stringValue?.lowercase().orEmpty()
                val role =
                    if (roleRaw.contains("user")) CodexMessageRole.user else CodexMessageRole.assistant
                DecodedCompletedItem(
                    role,
                    CodexMessageKind.chat,
                    sanitizeHistoryTextForKind(CodexMessageKind.chat, decodeItemText(itemObject)),
                    decodeImageAttachments(itemObject),
                    assistantPhase =
                        if (role == CodexMessageRole.assistant) {
                            IncomingNotificationParsers.extractAssistantPhase(null, itemObject)
                        } else {
                            null
                        },
                )
            }
            "reasoning" ->
                DecodedCompletedItem(
                    CodexMessageRole.system,
                    CodexMessageKind.thinking,
                    sanitizeHistoryTextForKind(CodexMessageKind.thinking, decodeReasoningText(itemObject)),
                )
            "filechange" -> {
                val body =
                    FileChangeItemBodyRenderer.renderFromIncomingItem(itemObject)?.trim()?.takeIf { it.isNotEmpty() }
                        ?: decodeItemText(itemObject).trim().takeIf { it.isNotEmpty() }
                        ?: decodeFileChangePreview(itemObject)
                DecodedCompletedItem(
                    CodexMessageRole.system,
                    CodexMessageKind.fileChange,
                    sanitizeHistoryTextForKind(CodexMessageKind.fileChange, body),
                )
            }
            "toolcall", "diff" -> {
                val t = sanitizeHistoryTextForKind(CodexMessageKind.fileChange, decodeToolOrDiffPreview(itemObject))
                if (t.isEmpty()) {
                    null
                } else {
                    DecodedCompletedItem(CodexMessageRole.system, CodexMessageKind.fileChange, t)
                }
            }
            "commandexecution" ->
                DecodedCompletedItem(
                    CodexMessageRole.system,
                    CodexMessageKind.commandExecution,
                    sanitizeHistoryTextForKind(CodexMessageKind.commandExecution, decodeCommandPreview(itemObject)),
                )
            "imagegeneration", "imagegenerationcall", "imagegenerationend", "imageview" -> {
                val imageAttachments = decodeGeneratedImageAttachments(itemObject)
                if (imageAttachments.isEmpty()) {
                    null
                } else {
                    DecodedCompletedItem(
                        CodexMessageRole.assistant,
                        CodexMessageKind.chat,
                        "",
                        imageAttachments,
                        assistantPhase = "final_answer",
                    )
                }
            }
            "plan" -> {
                val body =
                    decodeItemText(itemObject)
                        .ifEmpty {
                            itemObject["summary"]?.stringValue?.trim().orEmpty()
                        }.ifEmpty { "[plan]" }
                DecodedCompletedItem(
                    CodexMessageRole.system,
                    CodexMessageKind.plan,
                    sanitizeHistoryTextForKind(CodexMessageKind.plan, body),
                    planState = decodeHistoryPlanState(itemObject),
                )
            }
            else ->
                if (isSubagentHistoryItemType(norm)) {
                    decodeSubagentHistoryActionItem(itemObject)?.let { action ->
                        DecodedCompletedItem(
                            CodexMessageRole.system,
                            CodexMessageKind.subagentAction,
                            action.summaryText,
                            subagentAction = action,
                        )
                    }
                } else {
                    null
                }
        }
    }

    private fun append(
        out: MutableList<CodexMessage>,
        threadId: String,
        role: CodexMessageRole,
        kind: CodexMessageKind,
        text: String,
        turnId: String?,
        itemId: String?,
        createdAt: Instant,
        attachments: List<CodexImageAttachment> = emptyList(),
        planState: CodexPlanState? = null,
        subagentAction: CodexSubagentAction? = null,
        assistantPhase: String? = null,
    ) {
        val t = sanitizeHistoryTextForKind(kind, text)
        if (t.isEmpty() && attachments.isEmpty() && kind != CodexMessageKind.plan && subagentAction == null) return
        out.add(
            CodexMessage(
                threadId = threadId,
                role = role,
                kind = kind,
                assistantPhase = if (role == CodexMessageRole.assistant) assistantPhase else null,
                text = t,
                createdAt = createdAt,
                turnId = turnId,
                itemId = itemId,
                isStreaming = false,
                attachments = attachments,
                planState = planState,
                subagentAction = subagentAction,
            ),
        )
    }

    private fun decodeItemText(itemObject: Map<String, JSONValue>): String {
        val contentItems = itemObject["content"]?.arrayValue.orEmpty()
        val parts = ArrayList<String>()
        for (value in contentItems) {
            val o = value.objectValue ?: continue
            val t = normalizedHistoryItemType(o["type"]?.stringValue ?: "")
            when {
                t == "text" -> o["text"]?.stringValue?.let { parts.add(it) }
                (t == "inputtext" || t == "outputtext" || t == "message") ->
                    o["text"]?.stringValue?.let { parts.add(it) }
                t == "skill" -> {
                    val id = o["id"]?.stringValue?.trim().orEmpty()
                    val name = o["name"]?.stringValue?.trim().orEmpty()
                    val r = id.ifEmpty { name }
                    if (r.isNotEmpty()) parts.add("$$r")
                }
            }
        }
        val joined = parts.joinToString("\n").trim()
        if (joined.isNotEmpty()) return joined
        itemObject["text"]
            ?.stringValue
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?.let { return it }
        itemObject["message"]
            ?.stringValue
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?.let { return it }
        return ""
    }

    private fun decodeReasoningText(itemObject: Map<String, JSONValue>): String {
        listOf("summary", "text", "content").forEach { k ->
            itemObject[k]
                ?.stringValue
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
                ?.let { return it }
        }
        return decodeItemText(itemObject).ifEmpty { "[reasoning]" }
    }

    private fun decodeImageAttachments(itemObject: Map<String, JSONValue>): List<CodexImageAttachment> {
        val contentItems = itemObject["content"]?.arrayValue.orEmpty()
        val attachments = ArrayList<CodexImageAttachment>()
        for (value in contentItems) {
            val objectValue = value.objectValue ?: continue
            val normalizedType = normalizedHistoryItemType(objectValue["type"]?.stringValue ?: "")
            if (normalizedType != "image" && normalizedType != "localimage") continue
            val sourceUrl =
                objectValue["url"]?.stringValue
                    ?: objectValue["image_url"]?.stringValue
                    ?: objectValue["path"]?.stringValue
            TurnAttachmentCodec.attachmentFromHistorySource(sourceUrl)?.let { attachments.add(it) }
        }
        return attachments
    }

    private fun decodeGeneratedImageAttachments(itemObject: Map<String, JSONValue>): List<CodexImageAttachment> {
        val directSource =
            firstString(
                itemObject,
                listOf("saved_path", "savedPath", "file_path", "filePath", "path", "url", "image_url"),
            )
        val attachments =
            if (directSource != null) {
                listOfNotNull(TurnAttachmentCodec.attachmentFromHistorySource(directSource))
            } else {
                decodeImageAttachments(itemObject)
            }
        return attachments
    }

    private fun decodeFileChangePreview(itemObject: Map<String, JSONValue>): String {
        firstString(
            itemObject,
            listOf("path", "filePath", "file_path", "displayPath", "display_path"),
        )?.let { return it }
        return "[file change]"
    }

    private fun decodeFileChangeBody(itemObject: Map<String, JSONValue>): String =
        FileChangeItemBodyRenderer.renderFromIncomingItem(itemObject)?.trim()?.takeIf { it.isNotEmpty() }
            ?: decodeItemText(itemObject).trim().takeIf { it.isNotEmpty() }
            ?: decodeFileChangePreview(itemObject)

    private fun decodeToolOrDiffPreview(itemObject: Map<String, JSONValue>): String {
        FileChangeItemBodyRenderer
            .renderFromIncomingItem(itemObject)
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?.let { return it }
        return decodeItemText(itemObject)
            .trim()
            .takeIf { FileChangeItemBodyRenderer.hasFileChangeEvidence(it) }
            .orEmpty()
    }

    private fun decodeCommandPreview(itemObject: Map<String, JSONValue>): String {
        val cmd =
            firstString(
                itemObject,
                listOf("command", "cmd", "raw_command", "rawCommand", "input", "invocation"),
            ) ?: "command"
        val statusRaw = itemObject["status"]
        val status =
            when (statusRaw) {
                is JSONValue.Str -> statusRaw.value
                is JSONValue.Obj ->
                    statusRaw.map["type"]?.stringValue
                        ?: statusRaw.map["statusType"]?.stringValue
                        ?: statusRaw.map["status"]?.stringValue
                        ?: "completed"
                else -> statusRaw?.stringValue ?: "completed"
            }
        val phase =
            when {
                status.contains("fail", ignoreCase = true) || status.contains("error", ignoreCase = true) ->
                    "failed"
                status.contains("cancel", ignoreCase = true) ||
                    status.contains("abort", ignoreCase = true) -> "stopped"
                status.contains("complete", ignoreCase = true) ||
                    status.contains("success", ignoreCase = true) -> "completed"
                else -> "running"
            }
        val trimCmd =
            cmd.trim().ifBlank { "command" }.let { c ->
                val max = 8192
                if (c.length <= max) c else c.take(max - 1) + "…"
            }
        // `phase> cmd` matches parseCommandExecution's inlined phase header and preserves the full command.
        return "$phase> $trimCmd"
    }

    private fun firstString(
        obj: Map<String, JSONValue>,
        keys: List<String>,
    ): String? {
        for (k in keys) {
            obj[k]
                ?.stringValue
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
                ?.let { return it }
        }
        return null
    }
}
