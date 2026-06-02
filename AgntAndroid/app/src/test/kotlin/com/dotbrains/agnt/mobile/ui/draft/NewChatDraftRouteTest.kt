package com.dotbrains.agnt.mobile.ui.draft

import com.dotbrains.agnt.mobile.ui.navigation.AppRoutes
import java.net.URLDecoder
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NewChatDraftRouteTest {
    @Test
    fun create_generalChat_normalizesBlankPreferredPathToNull() {
        val route = NewChatDraftRoute.create(source = NewChatDraftSource.generalChat, preferredProjectPath = "   ")
        assertEquals(NewChatDraftSource.generalChat, route.source)
        assertNull(route.preferredProjectPath)
        assertTrue(route.id.startsWith("new-chat-draft-"))
    }

    @Test
    fun create_folderChat_trimsPreferredPath() {
        val route = NewChatDraftRoute.create(source = NewChatDraftSource.folderChat, preferredProjectPath = "  /repo  ")
        assertEquals(NewChatDraftSource.folderChat, route.source)
        assertEquals("/repo", route.preferredProjectPath)
    }

    @Test
    fun generalChatSourceFlag() {
        assertTrue(NewChatDraftSource.generalChat.isFromGeneralChat)
        assertTrue(!NewChatDraftSource.folderChat.isFromGeneralChat)
    }

    @Test
    fun appRoute_withoutPath_omitsPathQuery() {
        val built = AppRoutes.newChatDraftRoute(NewChatDraftSource.generalChat.name)
        assertEquals("new_chat_draft?source=generalChat", built)
    }

    @Test
    fun appRoute_withPath_urlEncodesPath() {
        val built = AppRoutes.newChatDraftRoute(NewChatDraftSource.folderChat.name, "/Users/me/My Repo")
        assertTrue(built.startsWith("new_chat_draft?source=folderChat&path="))
        val encodedPath = built.substringAfter("&path=")
        assertEquals("/Users/me/My Repo", URLDecoder.decode(encodedPath, "UTF-8"))
    }
}
