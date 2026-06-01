package com.dotbrains.agnt.mobile.data

import android.content.Context
import com.dotbrains.agnt.mobile.core.model.UserBubbleColor

object UserBubblePreferences {
    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(ThemePreferences.PREFS_NAME, Context.MODE_PRIVATE)

    fun read(context: Context): UserBubbleColor {
        val raw = prefs(context).getString(UserBubbleColor.storageKey, null)
        return UserBubbleColor.fromStorage(raw)
    }

    fun write(
        context: Context,
        color: UserBubbleColor,
    ) {
        prefs(context).edit().putString(UserBubbleColor.storageKey, color.name).apply()
    }
}
