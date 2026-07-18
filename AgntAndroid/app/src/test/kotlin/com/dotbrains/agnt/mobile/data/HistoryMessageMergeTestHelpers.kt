package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.CodexImageAttachment
import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexMessageDeliveryState
import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.CodexMessageRole
import java.time.Instant

internal fun message(
    id: String,
    role: CodexMessageRole = CodexMessageRole.system,
    kind: CodexMessageKind = CodexMessageKind.fileChange,
    text: String,
    turnId: String?,
    itemId: String?,
    isStreaming: Boolean,
    createdAt: Instant,
    deliveryState: CodexMessageDeliveryState = CodexMessageDeliveryState.confirmed,
    attachments: List<CodexImageAttachment> = emptyList(),
): CodexMessage =
    CodexMessage(
        id = id,
        threadId = "thread-1",
        role = role,
        kind = kind,
        text = text,
        createdAt = createdAt,
        turnId = turnId,
        itemId = itemId,
        isStreaming = isStreaming,
        deliveryState = deliveryState,
        attachments = attachments,
    )
