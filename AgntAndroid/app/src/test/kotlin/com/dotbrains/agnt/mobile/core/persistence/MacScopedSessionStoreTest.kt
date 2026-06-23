package com.dotbrains.agnt.mobile.core.persistence

import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.CodexThreadSyncState
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals

class MacScopedSessionStoreTest {
    @Test
    fun formatScopedKey_prefixesMacDeviceId() {
        assertEquals(
            "mac.mac-a.codex.ui.lastActiveThreadId",
            MacScopedSessionStore.formatScopedKey("codex.ui.lastActiveThreadId", "mac-a"),
        )
        assertEquals(
            "mac.mac-a.${MacScopedSessionStore.KEY_THREAD_RENAMES}",
            MacScopedSessionStore.formatScopedKey(MacScopedSessionStore.KEY_THREAD_RENAMES, "mac-a"),
        )
        assertEquals(
            "codex.ui.lastActiveThreadId",
            MacScopedSessionStore.formatScopedKey("codex.ui.lastActiveThreadId", null),
        )
        assertEquals(
            "codex.ui.lastActiveThreadId",
            MacScopedSessionStore.formatScopedKey("codex.ui.lastActiveThreadId", "  "),
        )
    }

    @Test
    fun scopedBaseKeys_mirrorSessionPersistenceLegacyKeys() {
        // Scoped base keys must equal the literal un-scoped SessionPersistence pref strings so the
        // legacy-migration flag aligns with the keys the un-scoped store reads/writes. The cached-
        // threads and runtime-selection fallbacks route through sessionPersistence.load*(), which own
        // their own keys, so those scoped base names are intentionally key-agnostic.
        assertEquals("codex.ui.lastActiveThreadId", MacScopedSessionStore.KEY_LAST_ACTIVE_THREAD)
        assertEquals("codex.thread.renamedThreadNames", MacScopedSessionStore.KEY_THREAD_RENAMES)
        assertEquals("codex.thread.associatedManagedWorktrees", MacScopedSessionStore.KEY_ASSOCIATED_WORKTREES)
        assertEquals("codex.locallyDeletedThreadIDs", MacScopedSessionStore.KEY_LOCALLY_DELETED)
        assertEquals("codex.locallyArchivedThreadIDs", MacScopedSessionStore.KEY_LOCALLY_ARCHIVED)
    }

    @Test
    fun composerDraftsKey_usesAgntNamespaceAndScopesPerMac() {
        // New key intentionally uses the agnt namespace (drafts are ephemeral, no migration).
        assertEquals("agnt.composer.draftsByThread", MacScopedSessionStore.KEY_COMPOSER_DRAFTS)
        assertEquals(
            "mac.mac-a.agnt.composer.draftsByThread",
            MacScopedSessionStore.formatScopedKey(MacScopedSessionStore.KEY_COMPOSER_DRAFTS, "mac-a"),
        )
    }

    @Test
    fun cachedThreadSnapshot_roundTripsMetadataAndEscapedText() {
        // Our CodexThread has no collaborationMode column, so the snapshot drops it (vs upstream).
        val original =
            CodexThread(
                id = "thread-1",
                title = "Title\twith tab",
                name = "Name\nwith newline",
                preview = "Preview with symbols %20",
                createdAt = Instant.parse("2026-05-01T10:00:00Z"),
                updatedAt = Instant.parse("2026-05-02T10:00:00Z"),
                cwd = "C:\\Users\\andre\\Project",
                syncState = CodexThreadSyncState.archivedLocal,
                forkedFromThreadId = "thread-0",
                parentThreadId = "parent-1",
                agentId = "agent-1",
                agentNickname = "Agent",
                agentRole = "reviewer",
                model = "gpt-5",
                modelProvider = "openai",
            )

        val encoded = MacScopedSessionStore.encodeCachedThreadSnapshot(listOf(original))
        val decoded = MacScopedSessionStore.decodeCachedThreadSnapshot(encoded)

        assertEquals(listOf(original), decoded)
    }
}
