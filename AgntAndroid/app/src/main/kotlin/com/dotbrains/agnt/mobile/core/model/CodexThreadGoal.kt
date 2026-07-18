package com.dotbrains.agnt.mobile.core.model

enum class CodexThreadGoalStatus(
    val wireValue: String,
) {
    Active("active"),
    Paused("paused"),
    Completed("completed"),
    Failed("failed"),
    Blocked("blocked"),
    UsageLimited("usageLimited"),
    BudgetLimited("budgetLimited"),
}

data class CodexThreadGoal(
    val threadId: String,
    val objective: String,
    val status: CodexThreadGoalStatus,
    val tokenBudget: Long? = null,
    val tokenUsage: Long? = null,
    val remainingTokens: Long? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
) {
    companion object {
        fun fromEnvelope(
            envelope: Map<String, JSONValue>?,
            fallbackThreadId: String? = null,
        ): CodexThreadGoal? {
            val goalObject =
                envelope?.get("goal")?.objectValue
                    ?: envelope?.takeIf { it.containsKey("objective") || it.containsKey("status") }
                    ?: return null
            return fromObject(goalObject, fallbackThreadId)
        }

        fun fromObject(
            obj: Map<String, JSONValue>,
            fallbackThreadId: String? = null,
        ): CodexThreadGoal? {
            val threadId =
                firstString(obj, "threadId", "thread_id", "conversationId", "conversation_id")
                    ?: fallbackThreadId?.trim()?.takeIf { it.isNotEmpty() }
                    ?: return null
            val objective = firstString(obj, "objective", "goal", "description") ?: return null
            val status =
                normalizeStatus(firstString(obj, "status", "state"))
                    ?: return null
            return CodexThreadGoal(
                threadId = threadId,
                objective = objective,
                status = status,
                tokenBudget = firstLong(obj, "tokenBudget", "token_budget", "budgetTokens", "budget_tokens"),
                tokenUsage = firstLong(obj, "tokenUsage", "token_usage", "usedTokens", "used_tokens"),
                remainingTokens = firstLong(obj, "remainingTokens", "remaining_tokens"),
                createdAt = firstString(obj, "createdAt", "created_at"),
                updatedAt = firstString(obj, "updatedAt", "updated_at"),
            )
        }

        fun normalizeStatus(raw: String?): CodexThreadGoalStatus? {
            val normalized =
                raw
                    ?.trim()
                    ?.lowercase()
                    ?.replace("_", "")
                    ?.replace("-", "") ?: return null
            return when (normalized) {
                "active", "running", "inprogress" -> CodexThreadGoalStatus.Active
                "paused", "pause" -> CodexThreadGoalStatus.Paused
                "completed", "complete", "done", "succeeded", "success" -> CodexThreadGoalStatus.Completed
                "failed", "failure", "error" -> CodexThreadGoalStatus.Failed
                "blocked" -> CodexThreadGoalStatus.Blocked
                "usagelimited", "usage" -> CodexThreadGoalStatus.UsageLimited
                "budgetlimited", "budget" -> CodexThreadGoalStatus.BudgetLimited
                else -> null
            }
        }

        fun formatTokenCount(value: Long): String =
            when {
                value >= 1_000_000 -> "${value / 1_000_000}M"
                value >= 1_000 -> "${value / 1_000}k"
                else -> value.toString()
            }

        fun remainingBudget(goal: CodexThreadGoal): Long? =
            goal.remainingTokens
                ?: goal.tokenBudget?.let { budget ->
                    (budget - (goal.tokenUsage ?: 0L)).coerceAtLeast(0L)
                }

        private fun firstString(
            obj: Map<String, JSONValue>,
            vararg keys: String,
        ): String? =
            keys.firstNotNullOfOrNull { key ->
                obj[key]?.stringValue?.trim()?.takeIf { it.isNotEmpty() }
            }

        private fun firstLong(
            obj: Map<String, JSONValue>,
            vararg keys: String,
        ): Long? =
            keys.firstNotNullOfOrNull { key ->
                when (val value = obj[key]) {
                    is JSONValue.NumLong -> value.value
                    is JSONValue.NumDouble -> value.value.toLong()
                    is JSONValue.Str ->
                        value.value
                            .trim()
                            .replace(",", "")
                            .toLongOrNull()
                    else -> null
                }
            }
    }
}

sealed interface CodexThreadGoalBudgetUpdate {
    data object Keep : CodexThreadGoalBudgetUpdate

    data object Clear : CodexThreadGoalBudgetUpdate

    data class Set(
        val tokens: Long,
    ) : CodexThreadGoalBudgetUpdate
}
