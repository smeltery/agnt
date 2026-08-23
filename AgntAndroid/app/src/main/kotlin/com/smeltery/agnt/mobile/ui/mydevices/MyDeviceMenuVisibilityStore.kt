package com.smeltery.agnt.mobile.ui.mydevices

import android.content.Context
import com.smeltery.agnt.mobile.AppContainer

/**
 * Persists, per paired computer, whether the device appears in the sidebar quick-switch menu and
 * its user-assigned nickname. Backed by local SharedPreferences; degrades to an in-memory map when
 * the application context is not yet available (e.g. unit tests).
 */
object MyDeviceMenuVisibilityStore {
    private const val KEY_PREFIX = "codex.myDevices.visibleInMenu."

    private val memoryValues = mutableMapOf<String, Boolean>()
    private val memoryStrings = mutableMapOf<String, String>()

    private fun prefs(): android.content.SharedPreferences? =
        runCatching {
            AppContainer.appContext.getSharedPreferences("agnt_my_devices", Context.MODE_PRIVATE)
        }.getOrNull()

    fun isVisible(deviceId: String?): Boolean {
        val key = storageKey(deviceId) ?: return true
        prefs()?.let { store ->
            if (!store.contains(key)) return true
            return store.getBoolean(key, true)
        }
        return memoryValues[key] ?: true
    }

    fun setVisible(
        isVisible: Boolean,
        deviceId: String?,
    ) {
        val key = storageKey(deviceId) ?: return
        prefs()?.edit()?.putBoolean(key, isVisible)?.apply()
            ?: run { memoryValues[key] = isVisible }
    }

    fun removePreference(deviceId: String?) {
        val key = storageKey(deviceId) ?: return
        prefs()?.edit()?.remove(key)?.apply()
        memoryValues.remove(key)
    }

    internal fun readString(key: String): String? = prefs()?.getString(key, null) ?: memoryStrings[key]

    internal fun writeString(
        key: String,
        value: String,
    ) {
        prefs()?.edit()?.putString(key, value)?.apply()
            ?: run { memoryStrings[key] = value }
    }

    internal fun removeString(key: String) {
        prefs()?.edit()?.remove(key)?.apply()
        memoryStrings.remove(key)
    }

    private fun storageKey(deviceId: String?): String? {
        val normalized = deviceId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return KEY_PREFIX + normalized
    }
}

/** User-assigned nickname per paired computer, surfaced as the primary name in the device list. */
object SidebarComputerNicknameStore {
    private const val KEY_PREFIX = "codex.sidebarComputerNickname."

    fun nickname(deviceId: String?): String {
        val key = storageKey(deviceId) ?: return ""
        return MyDeviceMenuVisibilityStore.readString(key).orEmpty()
    }

    fun setNickname(
        nickname: String,
        deviceId: String?,
    ) {
        val key = storageKey(deviceId) ?: return
        val trimmed = nickname.trim()
        if (trimmed.isEmpty()) {
            MyDeviceMenuVisibilityStore.removeString(key)
        } else {
            MyDeviceMenuVisibilityStore.writeString(key, trimmed)
        }
    }

    private fun storageKey(deviceId: String?): String? {
        val normalized = deviceId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return KEY_PREFIX + normalized
    }
}
