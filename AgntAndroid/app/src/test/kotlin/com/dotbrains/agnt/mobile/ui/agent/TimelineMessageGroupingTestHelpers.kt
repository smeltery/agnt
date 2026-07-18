package com.dotbrains.agnt.mobile.ui.agent

import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.CodexMessageRole
import java.time.Instant

internal val t0: Instant = Instant.parse("2024-01-01T00:00:00Z")

internal fun cmd(id: String): CodexMessage =
    CodexMessage(
        id = id,
        threadId = "t1",
        role = CodexMessageRole.system,
        kind = CodexMessageKind.commandExecution,
        text = "completed > $id",
        createdAt = t0,
    )

internal fun file(id: String): CodexMessage =
    CodexMessage(
        id = id,
        threadId = "t1",
        role = CodexMessageRole.system,
        kind = CodexMessageKind.fileChange,
        text = "path $id",
        createdAt = t0,
    )

internal fun thinking(id: String): CodexMessage =
    CodexMessage(
        id = id,
        threadId = "t1",
        role = CodexMessageRole.system,
        kind = CodexMessageKind.thinking,
        text = "Thinking...",
        createdAt = t0,
    )
