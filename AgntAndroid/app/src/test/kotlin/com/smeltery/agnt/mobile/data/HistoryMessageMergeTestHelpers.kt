package com.smeltery.agnt.mobile.data

import com.smeltery.agnt.mobile.core.model.CodexImageAttachment
import com.smeltery.agnt.mobile.core.model.CodexMessage
import com.smeltery.agnt.mobile.core.model.CodexMessageDeliveryState
import com.smeltery.agnt.mobile.core.model.CodexMessageKind
import com.smeltery.agnt.mobile.core.model.CodexMessageRole
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
