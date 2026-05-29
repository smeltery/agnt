package com.dotbrains.agnt.mobile.ui.shell

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.dotbrains.agnt.mobile.core.model.SystemNotice
import com.dotbrains.agnt.mobile.core.model.SystemNoticeSeverity

/**
 * Renders the toast queue from `system/notice` JSON-RPC notifications.
 * Stacks pills bottom-up so the newest sits closest to the composer. Each pill
 * is dismissable (kills the auto-dismiss timer) via the trailing close button.
 *
 * Parity model: web `useNoticesStore` + the Notices renderer in `app-shell.tsx`.
 */
@Composable
fun SystemNoticeHost(
    notices: List<SystemNotice>,
    onDismiss: (id: String) -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
) {
    if (notices.isEmpty()) return
    Column(
        modifier =
            modifier
                .fillMaxWidth()
                .padding(contentPadding),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // Stack newest-on-top so an incoming severity can shove the older row
        // upward rather than displacing the user's last-read pill.
        for (notice in notices.asReversed()) {
            AnimatedVisibility(
                visible = true,
                enter = slideInVertically(initialOffsetY = { full -> full }) + fadeIn(),
                exit = slideOutVertically(targetOffsetY = { full -> full / 2 }) + fadeOut(),
            ) {
                SystemNoticePill(notice = notice, onDismiss = { onDismiss(notice.id) })
            }
        }
    }
}

@Composable
private fun SystemNoticePill(
    notice: SystemNotice,
    onDismiss: () -> Unit,
) {
    val (container, content) = noticeColors(notice.severity)
    Row(
        modifier =
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(container)
                .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            notice.title?.let { title ->
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleSmall,
                    color = content,
                )
            }
            notice.message?.let { message ->
                if (notice.title != null) Spacer(modifier = Modifier.width(0.dp))
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodySmall,
                    color = content,
                )
            }
        }
        IconButton(onClick = onDismiss) {
            Icon(
                imageVector = Icons.Filled.Close,
                contentDescription = "Dismiss notice",
                tint = content,
            )
        }
    }
}

@Composable
private fun noticeColors(severity: SystemNoticeSeverity): Pair<Color, Color> {
    val scheme = MaterialTheme.colorScheme
    return when (severity) {
        SystemNoticeSeverity.Info -> scheme.secondaryContainer to scheme.onSecondaryContainer
        SystemNoticeSeverity.Warn -> scheme.tertiaryContainer to scheme.onTertiaryContainer
        SystemNoticeSeverity.Error -> scheme.errorContainer to scheme.onErrorContainer
    }
}
