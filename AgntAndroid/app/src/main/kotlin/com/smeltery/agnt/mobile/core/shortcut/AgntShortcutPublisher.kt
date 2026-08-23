package com.smeltery.agnt.mobile.core.shortcut

import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.os.Build
import com.smeltery.agnt.mobile.MainActivity
import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.core.model.CodexThread

object AgntShortcutPublisher {
    fun publish(
        context: Context,
        threads: List<CodexThread>,
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return
        val appContext = context.applicationContext
        val manager = appContext.getSystemService(ShortcutManager::class.java) ?: return
        manager.dynamicShortcuts =
            AgntShortcutCatalog.dynamicShortcuts(threads).map { item ->
                ShortcutInfo
                    .Builder(appContext, item.id)
                    .setShortLabel(item.shortLabel)
                    .setLongLabel(item.longLabel)
                    .setIcon(Icon.createWithResource(appContext, R.mipmap.ic_launcher))
                    .setIntent(intentFor(appContext, item.action))
                    .build()
            }
    }

    private fun intentFor(
        context: Context,
        action: AgntShortcutAction,
    ): Intent {
        val intent =
            Intent(context, MainActivity::class.java)
                .setAction(AgntShortcutCatalog.ACTION_SHORTCUT)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        when (action) {
            AgntShortcutAction.NewChat ->
                intent.putExtra(AgntShortcutCatalog.EXTRA_ACTION, AgntShortcutCatalog.ACTION_NEW_CHAT)
            is AgntShortcutAction.OpenThread ->
                intent
                    .putExtra(AgntShortcutCatalog.EXTRA_ACTION, AgntShortcutCatalog.ACTION_OPEN_THREAD)
                    .putExtra(AgntShortcutCatalog.EXTRA_THREAD_ID, action.threadId)
        }
        return intent
    }
}
