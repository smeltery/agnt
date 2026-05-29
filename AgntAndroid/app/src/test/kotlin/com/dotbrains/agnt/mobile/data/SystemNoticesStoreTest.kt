package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.SystemNoticeSeverity
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class SystemNoticesStoreTest {
    private fun newStore(
        scope: TestScope,
        ids: List<String> = listOf("n1", "n2", "n3"),
    ): SystemNoticesStore {
        val cursor = ids.iterator()
        return SystemNoticesStore(scope = scope, idFactory = { cursor.next() })
    }

    @Test
    fun enqueuePopulatesNoticeFields() =
        runTest(StandardTestDispatcher()) {
            val store = newStore(this)
            val notice =
                store.enqueue(
                    severity = SystemNoticeSeverity.Warn,
                    title = "  Warning  ",
                    message = "  Disk space low ",
                    provider = "opencode",
                    threadId = "thr-1",
                )
            assertNotNull(notice)
            assertEquals("n1", notice.id)
            assertEquals(SystemNoticeSeverity.Warn, notice.severity)
            assertEquals("Warning", notice.title) // trimmed
            assertEquals("Disk space low", notice.message) // trimmed
            assertEquals("opencode", notice.provider)
            assertEquals("thr-1", notice.threadId)
            assertEquals(listOf(notice), store.notices.value)
        }

    @Test
    fun emptyPayloadIsDropped() =
        runTest(StandardTestDispatcher()) {
            val store = newStore(this)
            val a = store.enqueue(SystemNoticeSeverity.Info, title = "  ", message = "  ", provider = null, threadId = null)
            val b = store.enqueue(SystemNoticeSeverity.Info, title = null, message = null, provider = null, threadId = null)
            assertNull(a)
            assertNull(b)
            assertTrue(store.notices.value.isEmpty())
        }

    @Test
    fun autoDismissUsesSeverityDefault() =
        runTest(StandardTestDispatcher()) {
            val store = newStore(this)
            store.enqueue(SystemNoticeSeverity.Info, title = "Hello", message = null, provider = null, threadId = null)
            assertEquals(1, store.notices.value.size)
            // Just before the 5s default
            advanceTimeBy(4_999)
            assertEquals(1, store.notices.value.size)
            advanceTimeBy(2) // cross the boundary
            assertEquals(0, store.notices.value.size)
        }

    @Test
    fun overrideDurationWinsOverDefault() =
        runTest(StandardTestDispatcher()) {
            val store = newStore(this)
            store.enqueue(
                severity = SystemNoticeSeverity.Error,
                title = "fast",
                message = null,
                provider = null,
                threadId = null,
                durationMsOverride = 100,
            )
            assertEquals(1, store.notices.value.size)
            advanceTimeBy(101)
            assertEquals(0, store.notices.value.size)
        }

    @Test
    fun zeroOrNegativeOverrideFallsBackToDefault() =
        runTest(StandardTestDispatcher()) {
            val store = newStore(this)
            store.enqueue(
                severity = SystemNoticeSeverity.Warn,
                title = "slow",
                message = null,
                provider = null,
                threadId = null,
                durationMsOverride = 0,
            )
            // Should auto-dismiss at the 8s Warn default, not 0ms.
            advanceTimeBy(7_999)
            assertEquals(1, store.notices.value.size)
            advanceTimeBy(2)
            assertEquals(0, store.notices.value.size)
        }

    @Test
    fun manualDismissCancelsTimer() =
        runTest(StandardTestDispatcher()) {
            val store = newStore(this)
            val notice = store.enqueue(SystemNoticeSeverity.Info, "hi", null, null, null)
            assertNotNull(notice)
            store.dismiss(notice.id)
            assertTrue(store.notices.value.isEmpty())
            // Advancing past the default duration shouldn't double-dismiss / crash.
            advanceTimeBy(10_000)
            assertTrue(store.notices.value.isEmpty())
        }

    @Test
    fun dismissUnknownIdIsNoOp() =
        runTest(StandardTestDispatcher()) {
            val store = newStore(this)
            store.dismiss("does-not-exist")
            assertTrue(store.notices.value.isEmpty())
        }

    @Test
    fun clearWipesAllNotices() =
        runTest(StandardTestDispatcher()) {
            val store = newStore(this)
            store.enqueue(SystemNoticeSeverity.Info, "a", null, null, null)
            store.enqueue(SystemNoticeSeverity.Warn, "b", null, null, null)
            assertEquals(2, store.notices.value.size)
            store.clear()
            assertTrue(store.notices.value.isEmpty())
            // Pending timers were cancelled too.
            advanceTimeBy(20_000)
            assertTrue(store.notices.value.isEmpty())
        }

    @Test
    fun notesAccumulateInArrivalOrder() =
        runTest(StandardTestDispatcher()) {
            val store = newStore(this)
            val a = store.enqueue(SystemNoticeSeverity.Info, "first", null, null, null)!!
            val b = store.enqueue(SystemNoticeSeverity.Warn, "second", null, null, null)!!
            assertEquals(listOf(a.id, b.id), store.notices.value.map { it.id })
        }
}
