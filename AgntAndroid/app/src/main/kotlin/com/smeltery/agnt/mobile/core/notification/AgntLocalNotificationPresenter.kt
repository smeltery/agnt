package com.smeltery.agnt.mobile.core.notification

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.smeltery.agnt.mobile.MainActivity
import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.core.model.PendingApprovalRequest
import com.smeltery.agnt.mobile.core.model.PendingStructuredInputRequest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

/**
 * Local-only notifications (no push). Shows when the app is backgrounded and posting is allowed.
 * Dedupes rapid repeats like iOS [AgentService+Notifications.swift].
 */
class AgntLocalNotificationPresenter(
    private val appContext: Context,
) {
    private val dedupeRunCompletion = ConcurrentHashMap<String, Long>()
    private val dedupeStructured = ConcurrentHashMap<String, Long>()
    private val dedupeApproval = ConcurrentHashMap<String, Long>()

    fun showOngoingRun(
        threadId: String,
        turnId: String?,
        displayTitle: String,
    ) {
        val th = OngoingRunNotificationLogic.normalizedThreadId(threadId) ?: return
        val tag = OngoingRunNotificationLogic.tag(th) ?: return
        val notificationId = stableNotificationId(NOTIFICATION_ID_ACTIVE_RUN_BASE, th)
        if (!OngoingRunNotificationLogic.shouldPost(th, AppForegroundTracker.isInForeground, canPostNotifications())) {
            cancelNotification(tag, notificationId)
            return
        }

        showNotification(
            notificationId = notificationId,
            tag = tag,
            title = displayTitle.ifBlank { appContext.getString(R.string.app_name) },
            body = appContext.getString(R.string.notification_run_running_body),
            contentIntent =
                contentIntent(
                    threadId = th,
                    turnId = turnId?.trim()?.takeIf { it.isNotEmpty() },
                    source = OngoingRunNotificationLogic.SOURCE_RUN_ACTIVE,
                ),
            ongoing = true,
            priority = NotificationCompat.PRIORITY_LOW,
        )
    }

    fun cancelOngoingRun(threadId: String) {
        val th = OngoingRunNotificationLogic.normalizedThreadId(threadId) ?: return
        val tag = OngoingRunNotificationLogic.tag(th) ?: return
        cancelNotification(tag, stableNotificationId(NOTIFICATION_ID_ACTIVE_RUN_BASE, th))
    }

    fun maybeNotifyRunCompletion(
        threadId: String,
        turnId: String?,
        kind: RunCompletionAttentionKind,
        displayTitle: String,
    ) {
        if (AppForegroundTracker.isInForeground) return
        if (!canPostNotifications()) return
        val th = threadId.trim()
        if (th.isEmpty()) return
        val now = System.currentTimeMillis()
        pruneOlderThan(dedupeRunCompletion, now, DEDUPE_WINDOW_MS)
        val dedupeKey = runCompletionDedupeKey(th, turnId, kind, now)
        if (isDedupedRecently(dedupeRunCompletion, dedupeKey, now)) return
        dedupeRunCompletion[dedupeKey] = now

        val bodyRes =
            when (kind) {
                RunCompletionAttentionKind.Completed -> R.string.notification_run_completed_body
                RunCompletionAttentionKind.Failed -> R.string.notification_run_failed_body
            }
        showNotification(
            notificationId = stableNotificationId(NOTIFICATION_ID_RUN_BASE, dedupeKey),
            tag = "run|$dedupeKey",
            title = displayTitle.ifBlank { appContext.getString(R.string.app_name) },
            body = appContext.getString(bodyRes),
            contentIntent =
                contentIntent(
                    threadId = th,
                    turnId = turnId,
                    source = SOURCE_RUN_COMPLETION,
                ),
        )
    }

    fun maybeNotifyPendingApproval(
        request: PendingApprovalRequest,
        displayTitle: String,
    ) {
        if (AppForegroundTracker.isInForeground) return
        if (!canPostNotifications()) return
        val th = request.threadId?.trim()?.takeIf { it.isNotEmpty() } ?: return
        val now = System.currentTimeMillis()
        pruneOlderThan(dedupeApproval, now, DEDUPE_WINDOW_MS)
        val dedupeKey = "$th|${request.id}"
        if (isDedupedRecently(dedupeApproval, dedupeKey, now)) return
        dedupeApproval[dedupeKey] = now

        showNotification(
            notificationId = stableNotificationId(NOTIFICATION_ID_APPROVAL_BASE, dedupeKey),
            tag = "approval|$dedupeKey",
            title = displayTitle.ifBlank { appContext.getString(R.string.app_name) },
            body = appContext.getString(R.string.notification_approval_body),
            contentIntent =
                contentIntent(
                    threadId = th,
                    turnId = request.turnId?.trim()?.takeIf { it.isNotEmpty() },
                    source = SOURCE_PENDING_APPROVAL,
                ),
        )
    }

    fun maybeNotifyStructuredInput(
        request: PendingStructuredInputRequest,
        displayTitle: String,
    ) {
        if (AppForegroundTracker.isInForeground) return
        if (!canPostNotifications()) return
        val th = request.threadId?.trim()?.takeIf { it.isNotEmpty() } ?: return
        val now = System.currentTimeMillis()
        pruneOlderThan(dedupeStructured, now, DEDUPE_WINDOW_MS)
        val dedupeKey = "$th|${request.id}"
        if (isDedupedRecently(dedupeStructured, dedupeKey, now)) return
        dedupeStructured[dedupeKey] = now

        val n = request.questions.size
        val body =
            if (n == 1) {
                appContext.getString(R.string.notification_structured_input_one)
            } else {
                appContext.getString(R.string.notification_structured_input_many, n)
            }
        showNotification(
            notificationId = stableNotificationId(NOTIFICATION_ID_INPUT_BASE, dedupeKey),
            tag = "input|$dedupeKey",
            title = displayTitle.ifBlank { appContext.getString(R.string.app_name) },
            body = body,
            contentIntent =
                contentIntent(
                    threadId = th,
                    turnId = request.turnId?.trim()?.takeIf { it.isNotEmpty() },
                    source = SOURCE_STRUCTURED_INPUT,
                ),
        )
    }

    private fun canPostNotifications(): Boolean = LocalNotificationSettings.canPostNotifications(appContext)

    private fun contentIntent(
        threadId: String,
        turnId: String?,
        source: String,
    ): PendingIntent {
        val token = issueLaunchToken(appContext, threadId)
        val intent =
            Intent(appContext, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(EXTRA_THREAD_ID, threadId)
                putExtra(EXTRA_TURN_ID, turnId.orEmpty())
                putExtra(EXTRA_SOURCE, source)
                putExtra(EXTRA_LAUNCH_TOKEN, token)
            }
        val flags =
            PendingIntent.FLAG_UPDATE_CURRENT or
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    PendingIntent.FLAG_IMMUTABLE
                } else {
                    0
                }
        return PendingIntent.getActivity(appContext, source.hashCode() xor threadId.hashCode(), intent, flags)
    }

    private fun showNotification(
        notificationId: Int,
        tag: String,
        title: String,
        body: String,
        contentIntent: PendingIntent,
        ongoing: Boolean = false,
        priority: Int = NotificationCompat.PRIORITY_DEFAULT,
    ) {
        val notification =
            NotificationCompat
                .Builder(appContext, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(priority)
                .setContentIntent(contentIntent)
                .setOnlyAlertOnce(ongoing)
                .setOngoing(ongoing)
                .setAutoCancel(!ongoing)
                .build()
        // canPostNotifications() gates the caller, but POST_NOTIFICATIONS can be
        // revoked between that check and this call (e.g. user toggled it in
        // Settings while the app was backgrounded). Swallow the resulting
        // SecurityException so a race-condition revoke doesn't crash the app —
        // the notification just doesn't show, which matches what the user just
        // asked for anyway.
        try {
            NotificationManagerCompat.from(appContext).notify(tag, notificationId, notification)
        } catch (e: SecurityException) {
            Log.w(TAG, "notify($tag) denied — POST_NOTIFICATIONS revoked at runtime: ${e.message}")
        }
    }

    private fun cancelNotification(
        tag: String,
        notificationId: Int,
    ) {
        NotificationManagerCompat.from(appContext).cancel(tag, notificationId)
    }

    private fun runCompletionDedupeKey(
        threadId: String,
        turnId: String?,
        kind: RunCompletionAttentionKind,
        now: Long,
    ): String {
        val t = turnId?.trim()?.takeIf { it.isNotEmpty() }
        return if (t != null) {
            "$threadId|$t|${kind.name}"
        } else {
            val bucket = now / 30_000
            "$threadId|${kind.name}|$bucket"
        }
    }

    companion object {
        const val CHANNEL_ID = "agnt_local_attention"
        const val EXTRA_THREAD_ID = "agnt.extra.THREAD_ID"
        const val EXTRA_TURN_ID = "agnt.extra.TURN_ID"
        const val EXTRA_SOURCE = "agnt.extra.SOURCE"
        const val EXTRA_LAUNCH_TOKEN = "agnt.extra.LAUNCH_TOKEN"

        const val SOURCE_RUN_COMPLETION = "agnt.runCompletion"
        const val SOURCE_PENDING_APPROVAL = "agnt.pendingApproval"
        const val SOURCE_STRUCTURED_INPUT = "agnt.structuredUserInput"

        private const val TAG = "AgntLocalNotificationPresenter"

        private const val DEDUPE_WINDOW_MS = 60_000L
        private const val NOTIFICATION_ID_RUN_BASE = 10_000
        private const val NOTIFICATION_ID_APPROVAL_BASE = 20_000
        private const val NOTIFICATION_ID_INPUT_BASE = 30_000
        private const val NOTIFICATION_ID_ACTIVE_RUN_BASE = 40_000
        private const val LAUNCH_TOKEN_PREFS = "agnt_notification_launch_tokens"
        private const val LAUNCH_TOKEN_BYTES = 32
        private val launchThreadIdRegex = Regex("^[A-Za-z0-9_-]{1,128}$")
        private val launchTokenRandom = SecureRandom()

        fun consumeLaunchToken(
            context: Context,
            intent: Intent,
            threadId: String,
        ): Boolean {
            val tid = threadId.trim().takeIf { it.isNotEmpty() } ?: return false
            if (!launchThreadIdRegex.matches(tid)) return false
            val token = intent.getStringExtra(EXTRA_LAUNCH_TOKEN)?.trim()?.takeIf { it.isNotEmpty() } ?: return false
            val prefs = context.applicationContext.getSharedPreferences(LAUNCH_TOKEN_PREFS, Context.MODE_PRIVATE)
            val key = tokenPrefsKey(tid)
            val expected = prefs.getString(key, null) ?: return false
            if (expected != token) return false
            prefs.edit().remove(key).apply()
            return true
        }

        fun ensureChannelCreated(appContext: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val ctx = appContext.applicationContext
            val mgr = ctx.getSystemService(NotificationManager::class.java) ?: return
            val channel =
                NotificationChannel(
                    CHANNEL_ID,
                    ctx.getString(R.string.notification_channel_name),
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = ctx.getString(R.string.notification_channel_description)
                    enableVibration(false)
                }
            mgr.createNotificationChannel(channel)
        }

        private fun pruneOlderThan(
            map: ConcurrentHashMap<String, Long>,
            now: Long,
            windowMs: Long,
        ) {
            val cutoff = now - windowMs
            map.entries.removeIf { it.value < cutoff }
        }

        private fun isDedupedRecently(
            map: ConcurrentHashMap<String, Long>,
            key: String,
            now: Long,
        ): Boolean {
            val prev = map[key] ?: return false
            return now - prev <= DEDUPE_WINDOW_MS
        }

        private fun stableNotificationId(
            base: Int,
            key: String,
        ): Int {
            val h = key.hashCode()
            return base + (h and 0x0FFF)
        }

        private fun issueLaunchToken(
            context: Context,
            threadId: String,
        ): String {
            val bytes = ByteArray(LAUNCH_TOKEN_BYTES)
            launchTokenRandom.nextBytes(bytes)
            val token = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
            context.applicationContext
                .getSharedPreferences(LAUNCH_TOKEN_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(tokenPrefsKey(threadId), token)
                .apply()
            return token
        }

        private fun tokenPrefsKey(threadId: String): String = "thread:${threadId.trim()}"
    }
}
