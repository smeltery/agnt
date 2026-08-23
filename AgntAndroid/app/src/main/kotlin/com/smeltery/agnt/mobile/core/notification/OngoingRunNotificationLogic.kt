package com.smeltery.agnt.mobile.core.notification

object OngoingRunNotificationLogic {
    const val SOURCE_RUN_ACTIVE = "agnt.runActive"
    const val TAG_PREFIX = "run-active"

    fun normalizedThreadId(threadId: String): String? = threadId.trim().takeIf { it.isNotEmpty() }

    fun tag(threadId: String): String? = normalizedThreadId(threadId)?.let { "$TAG_PREFIX|$it" }

    fun shouldPost(
        threadId: String,
        isForeground: Boolean,
        canPostNotifications: Boolean,
    ): Boolean = normalizedThreadId(threadId) != null && !isForeground && canPostNotifications
}
