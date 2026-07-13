package com.dotbrains.agnt.mobile.ui.turn

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.model.AIChangeSet
import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexMessageRole
import com.dotbrains.agnt.mobile.core.model.TurnUsageSheetLogic
import com.dotbrains.agnt.mobile.ui.turn.timeline.TurnRichMarkdownBody

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun FullTimelineMessageSheet(
    message: CodexMessage?,
    onDismiss: () -> Unit,
) {
    if (message == null) return
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 12.dp),
            verticalArrangement =
                androidx.compose.foundation.layout.Arrangement
                    .spacedBy(12.dp),
        ) {
            Text(
                text = stringResource(R.string.turn_message_full_sheet_title),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            TurnRichMarkdownBody(
                markdown = message.text.trim(),
                contentColor = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.fillMaxWidth(),
                keyPrefix = "full-${message.id}",
            )
        }
    }
}

fun assistantUndoChangeSetsByMessageId(
    messages: List<CodexMessage>,
    changeSets: List<AIChangeSet>,
): Map<String, AIChangeSet> {
    if (messages.isEmpty() || changeSets.isEmpty()) return emptyMap()
    val readyChangeSets =
        changeSets.filter { TurnUsageSheetLogic.revertPrimaryEnabled(it, runtimeRevertRpcAvailable = true) }
    val byAssistantMessageId =
        readyChangeSets
            .mapNotNull { changeSet ->
                changeSet.assistantMessageId
                    ?.trim()
                    ?.takeIf { it.isNotEmpty() }
                    ?.let { it to changeSet }
            }.toMap()
    val byTurnId = readyChangeSets.associateBy { it.turnId }
    val mapped =
        messages
            .asSequence()
            .filter { it.role == CodexMessageRole.assistant }
            .mapNotNull { message ->
                val changeSet =
                    byAssistantMessageId[message.id]
                        ?: message.itemId?.let { byAssistantMessageId[it] }
                        ?: message.turnId?.let { byTurnId[it] }
                changeSet?.let { message.id to it }
            }.toMap()
    if (mapped.isNotEmpty()) return mapped
    val latestAssistant = messages.lastOrNull { it.role == CodexMessageRole.assistant }
    val latestReady = readyChangeSets.maxByOrNull { it.createdAt }
    return if (latestAssistant != null && latestReady != null) {
        mapOf(latestAssistant.id to latestReady)
    } else {
        emptyMap()
    }
}
