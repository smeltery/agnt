package com.dotbrains.agnt.mobile.core.shortcut

import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.CodexThreadSyncState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AgntShortcutCatalogTest {
    @Test
    fun dynamicShortcuts_includeNewChatAndTwoRecentLiveThreads() {
        val shortcuts =
            AgntShortcutCatalog.dynamicShortcuts(
                listOf(
                    CodexThread(id = "t1", title = "First live", cwd = "/repo/one"),
                    CodexThread(id = "t2", title = "Second live", cwd = "/repo/two"),
                    CodexThread(id = "t3", title = "Third live", cwd = "/repo/three"),
                    CodexThread(id = "archived", title = "Archived", syncState = CodexThreadSyncState.archivedLocal),
                ),
            )

        assertEquals(listOf("new-chat", "thread:t1", "thread:t2"), shortcuts.map { it.id })
        assertEquals(AgntShortcutAction.NewChat, shortcuts[0].action)
        assertEquals(AgntShortcutAction.OpenThread("t1"), shortcuts[1].action)
        assertEquals("one", shortcuts[1].subtitle)
    }

    @Test
    fun dynamicShortcuts_trimsThreadIdsAndLabels() {
        val shortcuts =
            AgntShortcutCatalog.dynamicShortcuts(
                listOf(
                    CodexThread(id = "  t1  ", title = "A very long thread title that should be shortened"),
                ),
            )

        assertEquals("thread:t1", shortcuts[1].id)
        assertEquals(AgntShortcutAction.OpenThread("t1"), shortcuts[1].action)
        assertEquals("A very long threa…", shortcuts[1].shortLabel)
        assertEquals("A very long thread title that should be shortened", shortcuts[1].longLabel)
    }

    @Test
    fun actionFromIntentExtras_parsesKnownActions() {
        assertEquals(
            AgntShortcutAction.NewChat,
            AgntShortcutCatalog.actionFromIntentExtras(AgntShortcutCatalog.ACTION_NEW_CHAT, null),
        )
        assertEquals(
            AgntShortcutAction.OpenThread("thread-1"),
            AgntShortcutCatalog.actionFromIntentExtras(AgntShortcutCatalog.ACTION_OPEN_THREAD, " thread-1 "),
        )
    }

    @Test
    fun actionFromIntentExtras_rejectsInvalidPayloads() {
        assertNull(AgntShortcutCatalog.actionFromIntentExtras("unknown", "thread-1"))
        assertNull(AgntShortcutCatalog.actionFromIntentExtras(AgntShortcutCatalog.ACTION_OPEN_THREAD, "  "))
        assertNull(AgntShortcutCatalog.actionFromIntentExtras(AgntShortcutCatalog.ACTION_OPEN_THREAD, null))
    }
}
