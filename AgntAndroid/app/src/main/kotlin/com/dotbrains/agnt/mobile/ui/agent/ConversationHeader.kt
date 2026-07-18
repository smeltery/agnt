package com.dotbrains.agnt.mobile.ui.agent

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.model.GitDiffTotals
import com.dotbrains.agnt.mobile.core.model.TurnGitActionKind
import com.dotbrains.agnt.mobile.ui.theme.isAgentLightChrome

/** Truncate long filesystem paths for the header subtitle (middle ellipsis). */
fun truncatePathMiddle(
    path: String,
    maxLen: Int = 44,
): String {
    if (path.length <= maxLen) return path
    val ellipsis = "…"
    val inner = maxLen - ellipsis.length
    val head = inner / 2
    val tail = inner - head
    return path.take(head) + ellipsis + path.takeLast(tail)
}

/**
 * Main turn toolbar: title, repo path, running pill, diff totals (opens diff), git actions menu,
 * overflow (handoff / stop).
 * SwiftUI reference: [TurnToolbarContent](CodexMobile/CodexMobile/Views/Turn/TurnToolbarContent.swift).
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ConversationHeader(
    title: String,
    pathSubtitle: String?,
    onPathClick: (() -> Unit)?,
    showRunningPill: Boolean,
    repoDiffTotals: GitDiffTotals?,
    isLoadingRepoDiff: Boolean,
    onTapRepoDiff: (() -> Unit)?,
    showGitActions: Boolean,
    onGitAction: ((TurnGitActionKind) -> Unit)?,
    gitActionsBusy: Boolean,
    showsDiscardRuntimeRecovery: Boolean,
    isGitActionEnabled: Boolean,
    isGitInitialized: Boolean,
    showDesktopHandoff: Boolean,
    handingOffToDesktop: Boolean,
    showWorktreeHandoff: Boolean,
    handingOffWorktree: Boolean,
    isWorktreeProject: Boolean,
    showTurnStop: Boolean,
    onOpenDrawer: () -> Unit,
    onContinueDesktop: () -> Unit,
    onWorktreeHandoff: () -> Unit,
    onStopTurn: () -> Unit,
    showOpenTerminalHere: Boolean = false,
    onOpenTerminalHere: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    var overflowExpanded by remember { mutableStateOf(false) }
    var gitMenuExpanded by remember { mutableStateOf(false) }
    val showOverflow = showDesktopHandoff || showWorktreeHandoff || showTurnStop || showOpenTerminalHere
    val diffCd = stringResource(R.string.cd_git_repo_diff_totals)
    val gitMenuCd = stringResource(R.string.cd_git_actions_menu)
    val chrome = isAgentLightChrome()
    val pathColor =
        if (chrome) {
            MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.84f)
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.92f)
        }
    Box(
        modifier =
            modifier
                .fillMaxWidth()
                .height(160.dp),
    ) {
        HeaderAtmosphere(
            lightChrome = chrome,
            modifier =
                Modifier
                    .matchParentSize()
                    .statusBarsPadding()
                    .padding(top = 4.dp),
        )
        Column(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .align(Alignment.TopCenter)
                    .statusBarsPadding()
                    .padding(start = 14.dp, end = 10.dp, top = 12.dp),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                HeaderMenuButton(onOpenDrawer = onOpenDrawer)
                Text(
                    text = title,
                    style =
                        MaterialTheme.typography.titleLarge.copy(
                            lineHeight = 22.sp,
                        ),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (showRunningPill) {
                    Surface(
                        shape = MaterialTheme.shapes.large,
                        color = MaterialTheme.colorScheme.secondaryContainer,
                    ) {
                        Text(
                            text = stringResource(R.string.turn_top_bar_thinking),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSecondaryContainer,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
                        )
                    }
                }
                HeaderActions(
                    isLoadingRepoDiff = isLoadingRepoDiff,
                    repoDiffTotals = repoDiffTotals,
                    onTapRepoDiff = onTapRepoDiff,
                    diffCd = diffCd,
                    showGitActions = showGitActions,
                    onGitAction = onGitAction,
                    gitActionsBusy = gitActionsBusy,
                    showsDiscardRuntimeRecovery = showsDiscardRuntimeRecovery,
                    isGitActionEnabled = isGitActionEnabled,
                    isGitInitialized = isGitInitialized,
                    gitMenuCd = gitMenuCd,
                    showOverflow = showOverflow,
                    overflowExpanded = overflowExpanded,
                    onSetOverflowExpanded = { overflowExpanded = it },
                    gitMenuExpanded = gitMenuExpanded,
                    onSetGitMenuExpanded = { gitMenuExpanded = it },
                    showDesktopHandoff = showDesktopHandoff,
                    handingOffToDesktop = handingOffToDesktop,
                    showWorktreeHandoff = showWorktreeHandoff,
                    handingOffWorktree = handingOffWorktree,
                    isWorktreeProject = isWorktreeProject,
                    showTurnStop = showTurnStop,
                    onContinueDesktop = onContinueDesktop,
                    onWorktreeHandoff = onWorktreeHandoff,
                    showOpenTerminalHere = showOpenTerminalHere,
                    onOpenTerminalHere = onOpenTerminalHere,
                    onStopTurn = onStopTurn,
                )
            }
            if (pathSubtitle != null && onPathClick != null) {
                val pathSemanticsLabel = stringResource(R.string.turn_thread_path_dialog_title)
                Row(
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .offset(y = (-2).dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(modifier = Modifier.size(36.dp))
                    Text(
                        text = pathSubtitle,
                        modifier =
                            Modifier
                                .weight(1f)
                                .padding(start = 8.dp),
                        style =
                            MaterialTheme.typography.labelSmall.copy(
                                lineHeight = 14.sp,
                            ),
                        fontFamily = FontFamily.Monospace,
                        color = pathColor,
                        maxLines = 1,
                        overflow = TextOverflow.MiddleEllipsis,
                    )
                    Box(
                        modifier =
                            Modifier
                                .size(28.dp)
                                .clickable(onClick = onPathClick)
                                .semantics {
                                    contentDescription = pathSemanticsLabel
                                    role = Role.Button
                                },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.ContentCopy,
                            contentDescription = null,
                            modifier = Modifier.size(15.dp),
                            tint = pathColor,
                        )
                    }
                }
            }
        }
    }
}
