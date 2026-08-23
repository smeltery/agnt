package com.smeltery.agnt.mobile.core.notification

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class OngoingRunNotificationLogicTest {
    @Test
    fun normalizedThreadId_trimsAndRejectsBlank() {
        assertEquals("thread-1", OngoingRunNotificationLogic.normalizedThreadId(" thread-1 "))
        assertNull(OngoingRunNotificationLogic.normalizedThreadId("   "))
    }

    @Test
    fun tag_isStablePerThread() {
        assertEquals("run-active|thread-1", OngoingRunNotificationLogic.tag(" thread-1 "))
    }

    @Test
    fun shouldPost_requiresBackgroundPermissionAndThread() {
        assertTrue(
            OngoingRunNotificationLogic.shouldPost(
                threadId = "thread-1",
                isForeground = false,
                canPostNotifications = true,
            ),
        )
        assertFalse(
            OngoingRunNotificationLogic.shouldPost(
                threadId = "thread-1",
                isForeground = true,
                canPostNotifications = true,
            ),
        )
        assertFalse(
            OngoingRunNotificationLogic.shouldPost(
                threadId = "thread-1",
                isForeground = false,
                canPostNotifications = false,
            ),
        )
        assertFalse(
            OngoingRunNotificationLogic.shouldPost(
                threadId = " ",
                isForeground = false,
                canPostNotifications = true,
            ),
        )
    }
}
