package com.smeltery.agnt.mobile.data.history

import com.smeltery.agnt.mobile.core.model.CodexImageAttachment
import com.smeltery.agnt.mobile.core.model.CodexMessageKind
import com.smeltery.agnt.mobile.core.model.CodexMessageRole
import com.smeltery.agnt.mobile.core.model.CodexPlanState
import com.smeltery.agnt.mobile.core.model.CodexSubagentAction

internal data class DecodedCompletedItem(
    val role: CodexMessageRole,
    val kind: CodexMessageKind,
    val text: String,
    val attachments: List<CodexImageAttachment> = emptyList(),
    val planState: CodexPlanState? = null,
    val subagentAction: CodexSubagentAction? = null,
    val assistantPhase: String? = null,
)
