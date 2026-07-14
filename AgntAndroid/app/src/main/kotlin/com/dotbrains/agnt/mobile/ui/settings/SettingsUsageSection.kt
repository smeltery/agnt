package com.dotbrains.agnt.mobile.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.model.CodexRateLimitBucket
import com.dotbrains.agnt.mobile.core.model.ContextWindowUsage
import com.dotbrains.agnt.mobile.core.transport.ConnectionState
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.ui.shared.UsageStatusSummary
import kotlinx.coroutines.launch

@Composable
internal fun SettingsUsageRateLimitsSection(repository: CodexRepository) {
    val sessionReady by repository.isSessionReady.collectAsStateWithLifecycle()
    val conn by repository.connectionState.collectAsStateWithLifecycle()
    val hasResolved by repository.hasResolvedRateLimitsSnapshot.collectAsStateWithLifecycle()
    val isLoading by repository.isLoadingRateLimits.collectAsStateWithLifecycle()
    val err by repository.rateLimitsErrorMessage.collectAsStateWithLifecycle()
    val buckets by repository.rateLimitBuckets.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    LaunchedEffect(sessionReady, conn, hasResolved, err, isLoading) {
        if (sessionReady &&
            conn is ConnectionState.Connected &&
            !hasResolved &&
            err == null &&
            !isLoading
        ) {
            runCatching { repository.refreshRateLimits() }
        }
    }

    val displayRows = remember(buckets) { CodexRateLimitBucket.visibleDisplayRows(buckets) }
    val refreshCd = stringResource(R.string.cd_usage_rate_limits_refresh)
    val activeThreadId by repository.activeThreadId.collectAsStateWithLifecycle()
    val contextUsageMap by repository.contextWindowUsageByThread.collectAsStateWithLifecycle()
    val contextLoading by repository.contextWindowUsageLoadingThreads.collectAsStateWithLifecycle()
    val contextErrors by repository.contextWindowUsageErrorByThread.collectAsStateWithLifecycle()

    Text(
        text = stringResource(R.string.usage_rate_limits_hint),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    val usageSummary =
        activeThreadId
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?.let { tid -> contextUsageMap[tid] }
    UsageStatusSummary(
        contextUsage = usageSummary,
        rateLimitRows = displayRows,
        loading = isLoading,
    )

    Text(
        text = stringResource(R.string.usage_context_window_title),
        style = MaterialTheme.typography.titleSmall,
    )
    Text(
        text = stringResource(R.string.usage_context_window_hint),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    SettingsContextWindowUsageControls(
        sessionReady = sessionReady,
        conn = conn,
        activeThreadId = activeThreadId,
        contextUsageMap = contextUsageMap,
        contextLoading = contextLoading,
        contextErrors = contextErrors,
        onRefresh = { tid -> scope.launch { runCatching { repository.refreshContextWindowUsage(tid) } } },
    )

    Text(
        text = stringResource(R.string.usage_account_limits_title),
        style = MaterialTheme.typography.titleSmall,
    )

    SettingsRateLimitControls(
        sessionReady = sessionReady,
        conn = conn,
        hasResolved = hasResolved,
        isLoading = isLoading,
        err = err,
        displayRows = displayRows,
        refreshCd = refreshCd,
        onRefresh = { scope.launch { runCatching { repository.refreshRateLimits() } } },
    )
}

@Composable
private fun SettingsContextWindowUsageControls(
    sessionReady: Boolean,
    conn: ConnectionState,
    activeThreadId: String?,
    contextUsageMap: Map<String, ContextWindowUsage>,
    contextLoading: Set<String>,
    contextErrors: Map<String, String>,
    onRefresh: (String) -> Unit,
) {
    when {
        activeThreadId.isNullOrBlank() -> {
            Text(
                text = stringResource(R.string.usage_context_window_no_thread),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        !sessionReady || conn !is ConnectionState.Connected -> {
            Text(
                text = stringResource(R.string.usage_rate_limits_offline),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        else -> {
            val tid = activeThreadId.trim()
            val usage = contextUsageMap[tid]
            val ctxLoading = contextLoading.contains(tid)
            val ctxErr = contextErrors[tid]
            val ctxRefreshCd = stringResource(R.string.cd_usage_context_window_refresh)
            val ctxLoadingCd = stringResource(R.string.cd_usage_context_window_loading)
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(
                    onClick = { onRefresh(tid) },
                    enabled = !ctxLoading,
                    modifier = Modifier.semantics { contentDescription = ctxRefreshCd },
                ) {
                    Text(stringResource(R.string.usage_context_window_refresh))
                }
                if (ctxLoading) {
                    Spacer(modifier = Modifier.width(8.dp))
                    CircularProgressIndicator(
                        modifier =
                            Modifier
                                .size(20.dp)
                                .align(Alignment.CenterVertically)
                                .semantics { contentDescription = ctxLoadingCd },
                        strokeWidth = 2.dp,
                    )
                }
            }
            ctxErr?.let { message ->
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            if (!ctxLoading && ctxErr == null && usage == null) {
                Text(
                    text = stringResource(R.string.usage_context_window_empty),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            usage?.let { u ->
                LinearProgressIndicator(
                    progress = { u.fractionUsed.toFloat().coerceIn(0f, 1f) },
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text =
                        stringResource(
                            R.string.usage_context_window_tokens,
                            u.tokensUsedFormatted,
                            u.tokenLimitFormatted,
                            u.percentUsed,
                        ),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

@Composable
private fun SettingsRateLimitControls(
    sessionReady: Boolean,
    conn: ConnectionState,
    hasResolved: Boolean,
    isLoading: Boolean,
    err: String?,
    displayRows: List<com.dotbrains.agnt.mobile.core.model.CodexRateLimitDisplayRow>,
    refreshCd: String,
    onRefresh: () -> Unit,
) {
    if (!sessionReady || conn !is ConnectionState.Connected) {
        Text(
            text = stringResource(R.string.usage_rate_limits_offline),
            style = MaterialTheme.typography.bodyMedium,
        )
    } else {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(
                onClick = onRefresh,
                enabled = !isLoading,
                modifier = Modifier.semantics { contentDescription = refreshCd },
            ) {
                Text(stringResource(R.string.usage_rate_limits_refresh))
            }
            if (isLoading) {
                Spacer(modifier = Modifier.width(8.dp))
                val loadingCd = stringResource(R.string.cd_usage_rate_limits_loading)
                CircularProgressIndicator(
                    modifier =
                        Modifier
                            .size(20.dp)
                            .align(Alignment.CenterVertically)
                            .semantics { contentDescription = loadingCd },
                    strokeWidth = 2.dp,
                )
            }
        }
        err?.let { message ->
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        if (!isLoading && err == null && hasResolved && displayRows.isEmpty()) {
            Text(
                text = stringResource(R.string.usage_rate_limits_empty),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            displayRows.forEach { row ->
                Column(Modifier.fillMaxWidth()) {
                    Text(
                        text = row.label,
                        style = MaterialTheme.typography.labelLarge,
                    )
                    Spacer(Modifier.height(4.dp))
                    LinearProgressIndicator(
                        progress = { row.window.clampedUsedPercent / 100f },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(2.dp))
                    Text(
                        text = stringResource(R.string.usage_rate_limits_percent, row.window.clampedUsedPercent),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}
