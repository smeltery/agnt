package com.dotbrains.agnt.mobile.core.persistence

import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Exercises the pure copy/rename/merge logic behind [SharedPrefsMigration]. The project has no
 * Robolectric, so the Android wiring (file existence, EncryptedSharedPreferences) is left to manual
 * verification; the value-preserving core is covered here against a fake [SharedPreferences.Editor].
 */
class SharedPrefsMigrationTest {
    @Test
    fun copyEntries_preservesEachSupportedType() {
        val source =
            mapOf(
                "s" to "value",
                "b" to true,
                "i" to 7,
                "l" to 9_000_000_000L,
                "f" to 1.5f,
                "set" to setOf("a", "b"),
            )
        val editor = FakeEditor()

        SharedPrefsMigration.copyEntries(source, editor)

        assertEquals("value", editor.stored["s"])
        assertEquals(true, editor.stored["b"])
        assertEquals(7, editor.stored["i"])
        assertEquals(9_000_000_000L, editor.stored["l"])
        assertEquals(1.5f, editor.stored["f"])
        assertEquals(setOf("a", "b"), editor.stored["set"])
    }

    @Test
    fun copyEntries_skipsUnsupportedTypes() {
        val editor = FakeEditor()

        SharedPrefsMigration.copyEntries(mapOf("good" to "x", "bad" to Any()), editor)

        assertEquals("x", editor.stored["good"])
        assertFalse(editor.stored.containsKey("bad"))
    }

    @Test
    fun renameKeys_remapsKnownKeysAndKeepsOthers() {
        val source = mapOf("remodex.appTheme" to "dark", "codex.untouched" to "keep")
        val renames = mapOf("remodex.appTheme" to "agnt.appTheme")

        val result = SharedPrefsMigration.renameKeys(source, renames)

        assertEquals("dark", result["agnt.appTheme"])
        assertEquals("keep", result["codex.untouched"])
        assertFalse(result.containsKey("remodex.appTheme"))
    }

    @Test
    fun renameKeys_doesNotOverwriteExistingNewKey() {
        // Both old and new key present: the existing new-key value must win, old is dropped.
        val source = mapOf("remodex.appTheme" to "old", "agnt.appTheme" to "current")
        val renames = mapOf("remodex.appTheme" to "agnt.appTheme")

        val result = SharedPrefsMigration.renameKeys(source, renames)

        assertEquals("current", result["agnt.appTheme"])
        assertFalse(result.containsKey("remodex.appTheme"))
    }

    @Test
    fun renameKeys_emptyRenamesReturnsCopy() {
        val source = mapOf("a" to 1, "b" to 2)

        val result = SharedPrefsMigration.renameKeys(source, emptyMap())

        assertEquals(mapOf("a" to 1, "b" to 2), result)
    }

    @Test
    fun mergeMissing_keepsOnlyKeysAbsentFromExisting() {
        // Mirrors the agnt_ui case: language key already migrated; theme/font carried across.
        val source = mapOf("agnt.appLanguage" to "english", "agnt.appTheme" to "dark", "font" to "mono")
        val existing = mapOf("agnt.appLanguage" to "system")

        val result = SharedPrefsMigration.mergeMissing(source, existing)

        assertNull(result["agnt.appLanguage"])
        assertEquals("dark", result["agnt.appTheme"])
        assertEquals("mono", result["font"])
    }

    @Test
    fun mergeMissing_emptyExistingCopiesAll() {
        val source = mapOf("a" to 1, "b" to 2)

        val result = SharedPrefsMigration.mergeMissing(source, emptyMap<String, Any?>())

        assertTrue(result.keys.containsAll(setOf("a", "b")))
        assertEquals(2, result.size)
    }

    /** Minimal in-memory [SharedPreferences.Editor] capturing put* calls for assertions. */
    private class FakeEditor : SharedPreferences.Editor {
        val stored = mutableMapOf<String, Any?>()

        override fun putString(
            key: String,
            value: String?,
        ): SharedPreferences.Editor {
            stored[key] = value
            return this
        }

        override fun putStringSet(
            key: String,
            values: MutableSet<String>?,
        ): SharedPreferences.Editor {
            stored[key] = values
            return this
        }

        override fun putInt(
            key: String,
            value: Int,
        ): SharedPreferences.Editor {
            stored[key] = value
            return this
        }

        override fun putLong(
            key: String,
            value: Long,
        ): SharedPreferences.Editor {
            stored[key] = value
            return this
        }

        override fun putFloat(
            key: String,
            value: Float,
        ): SharedPreferences.Editor {
            stored[key] = value
            return this
        }

        override fun putBoolean(
            key: String,
            value: Boolean,
        ): SharedPreferences.Editor {
            stored[key] = value
            return this
        }

        override fun remove(key: String): SharedPreferences.Editor {
            stored.remove(key)
            return this
        }

        override fun clear(): SharedPreferences.Editor {
            stored.clear()
            return this
        }

        override fun commit(): Boolean = true

        override fun apply() = Unit
    }
}
