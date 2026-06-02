package com.dotbrains.agnt.mobile.core.persistence

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * One-time migration of legacy upstream-named (`remodex_*`) SharedPreferences and pref keys to the
 * `agnt_*` namespace. Runs once at startup, before any pref-backed service is constructed (see
 * [com.dotbrains.agnt.mobile.AgntApplication.onCreate]). Idempotent: a `migrated` marker in the new
 * session-state file short-circuits subsequent launches.
 *
 * The encrypted store is migrated through the [EncryptedSharedPreferences] API (never the raw xml)
 * so values stay decryptable under the same [MasterKey]. Plain files are copied entry-by-entry,
 * preserving the original value types.
 */
object SharedPrefsMigration {
    private const val TAG = "AgntSharedPrefsMigration"

    private const val MIGRATION_MARKER_KEY = "agnt.migration.sharedPrefsRebrand.v1.done"

    // Legacy (upstream) → new file names. The new session-state file also holds the migration marker.
    private const val LEGACY_SECURE_STORE = "remodex_secure_store"
    private const val NEW_SECURE_STORE = "agnt_secure_store"
    private const val LEGACY_SESSION_STATE = "remodex_session_state"
    private const val NEW_SESSION_STATE = "agnt_session_state"
    private const val LEGACY_UI = "remodex_ui"
    private const val NEW_UI = "agnt_ui"
    private const val LEGACY_ONBOARDING = "remodex_onboarding"
    private const val NEW_ONBOARDING = "agnt_onboarding"
    private const val LEGACY_LAUNCH_TOKENS = "remodex_notification_launch_tokens"
    private const val NEW_LAUNCH_TOKENS = "agnt_notification_launch_tokens"

    // Within-file pref key renames, applied to the NEW file after the file-level copy.
    private val SESSION_STATE_KEY_RENAMES =
        mapOf(
            "remodex.secure.forceQrBootstrap" to "agnt.secure.forceQrBootstrap",
            "remodex.localRelayHostOverride" to "agnt.localRelayHostOverride",
        )
    private val UI_KEY_RENAMES =
        mapOf(
            "remodex.appTheme" to "agnt.appTheme",
            "remodex.appLanguage" to "agnt.appLanguage",
        )

    /** Entry point. Safe to call on every launch; runs the copy work at most once per install. */
    fun runIfNeeded(context: Context) {
        val app = context.applicationContext
        val newSession = app.getSharedPreferences(NEW_SESSION_STATE, Context.MODE_PRIVATE)
        if (newSession.getBoolean(MIGRATION_MARKER_KEY, false)) return

        runCatching { migrateEncryptedStore(app) }
            .onFailure { Log.w(TAG, "secure-store migration failed: ${it.message}") }
        runCatching { migratePlainFile(app, LEGACY_SESSION_STATE, NEW_SESSION_STATE, SESSION_STATE_KEY_RENAMES) }
            .onFailure { Log.w(TAG, "session-state migration failed: ${it.message}") }
        runCatching { migratePlainFile(app, LEGACY_UI, NEW_UI, UI_KEY_RENAMES) }
            .onFailure { Log.w(TAG, "ui migration failed: ${it.message}") }
        runCatching { migratePlainFile(app, LEGACY_ONBOARDING, NEW_ONBOARDING, emptyMap()) }
            .onFailure { Log.w(TAG, "onboarding migration failed: ${it.message}") }
        runCatching { migratePlainFile(app, LEGACY_LAUNCH_TOKENS, NEW_LAUNCH_TOKENS, emptyMap()) }
            .onFailure { Log.w(TAG, "launch-token migration failed: ${it.message}") }

        newSession.edit().putBoolean(MIGRATION_MARKER_KEY, true).apply()
    }

    /**
     * Copies every entry from the legacy encrypted store into the new one (only when the new store is
     * empty), then deletes the legacy file. Both stores open under the same [MasterKey], so the values
     * stay decryptable. Wrapped by the caller; failures leave the legacy store untouched.
     */
    private fun migrateEncryptedStore(context: Context) {
        if (!hasPrefsFile(context, LEGACY_SECURE_STORE)) return

        val masterKey =
            MasterKey
                .Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()

        fun open(name: String): SharedPreferences =
            EncryptedSharedPreferences.create(
                context,
                name,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )

        val legacy = open(LEGACY_SECURE_STORE)
        val target = open(NEW_SECURE_STORE)
        if (target.all.isNotEmpty()) {
            // New store already populated (e.g. partial prior run): don't clobber it, just retire legacy.
            context.deleteSharedPreferences(LEGACY_SECURE_STORE)
            return
        }
        copyEntries(legacy.all, target.edit()).apply()
        context.deleteSharedPreferences(LEGACY_SECURE_STORE)
    }

    /**
     * Merges a plain (unencrypted) legacy file into its new name, applying [keyRenames] to the copied
     * snapshot, then deletes the legacy file. Keys already present in the new file win (so a partially
     * migrated `agnt_ui` — e.g. the language key that already moved over in an earlier release — is
     * never clobbered), while legacy-only keys (theme, font) are carried across.
     */
    private fun migratePlainFile(
        context: Context,
        legacyName: String,
        newName: String,
        keyRenames: Map<String, String>,
    ) {
        if (!hasPrefsFile(context, legacyName)) return
        val legacy = context.getSharedPreferences(legacyName, Context.MODE_PRIVATE)
        val target = context.getSharedPreferences(newName, Context.MODE_PRIVATE)
        val migrated = mergeMissing(renameKeys(legacy.all, keyRenames), target.all)
        copyEntries(migrated, target.edit()).apply()
        context.deleteSharedPreferences(legacyName)
    }

    private fun hasPrefsFile(
        context: Context,
        name: String,
    ): Boolean {
        val file = java.io.File(context.applicationInfo.dataDir, "shared_prefs/$name.xml")
        return file.exists()
    }

    /**
     * Pure copy logic: writes every [entries] value onto [editor], preserving the source type
     * (String / Boolean / Int / Long / Float / Set<String>). Extracted so it can be unit-tested
     * against a fake [SharedPreferences.Editor] without Robolectric. Unknown types are skipped.
     */
    fun copyEntries(
        entries: Map<String, *>,
        editor: SharedPreferences.Editor,
    ): SharedPreferences.Editor {
        for ((key, value) in entries) {
            when (value) {
                is String -> editor.putString(key, value)
                is Boolean -> editor.putBoolean(key, value)
                is Int -> editor.putInt(key, value)
                is Long -> editor.putLong(key, value)
                is Float -> editor.putFloat(key, value)
                is Set<*> -> editor.putStringSet(key, value.filterIsInstance<String>().toMutableSet())
                else -> Unit
            }
        }
        return editor
    }

    /**
     * Pure key-rename logic: returns a copy of [entries] with any key present in [renames] remapped
     * to its new name (value preserved). A pre-existing new-key value is not overwritten. Extracted
     * for unit testing.
     */
    fun renameKeys(
        entries: Map<String, *>,
        renames: Map<String, String>,
    ): Map<String, Any?> {
        if (renames.isEmpty()) return entries.toMap()
        val result = LinkedHashMap<String, Any?>()
        for ((key, value) in entries) {
            val newKey = renames[key]
            if (newKey == null) {
                result[key] = value
            } else if (!result.containsKey(newKey) && !entries.containsKey(newKey)) {
                result[newKey] = value
            }
        }
        return result
    }

    /**
     * Pure merge logic: returns only the [source] entries whose key is absent from [existing]. Used so
     * a file the new namespace already partially owns keeps its current values and gains the missing
     * legacy ones. Extracted for unit testing.
     */
    fun mergeMissing(
        source: Map<String, *>,
        existing: Map<String, *>,
    ): Map<String, Any?> {
        val result = LinkedHashMap<String, Any?>()
        for ((key, value) in source) {
            if (!existing.containsKey(key)) result[key] = value
        }
        return result
    }
}
