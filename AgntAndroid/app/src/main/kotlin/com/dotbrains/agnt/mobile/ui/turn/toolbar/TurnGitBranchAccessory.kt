package com.dotbrains.agnt.mobile.ui.turn.toolbar

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.data.GitBranchDisplaySummary
import com.dotbrains.agnt.mobile.ui.theme.AgentLightColors
import com.dotbrains.agnt.mobile.ui.theme.isAgentLightChrome
import com.composables.icons.lucide.R as LucideR

/** Read-only Git branch / worktree snapshot for the active thread (J.7c), with optional picker. */
sealed class GitBranchPaneState {
    data object UnavailableNoProject : GitBranchPaneState()

    data object AwaitingBridge : GitBranchPaneState()

    data object Loading : GitBranchPaneState()

    data class Loaded(
        val summary: GitBranchDisplaySummary,
    ) : GitBranchPaneState()

    data class Failed(
        val message: String,
    ) : GitBranchPaneState()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TurnGitBranchAccessory(
    state: GitBranchPaneState,
    branchPickerEnabled: Boolean,
    isSwitchingBranch: Boolean,
    onRefreshBranches: () -> Unit,
    onCheckoutBranch: (String) -> Unit,
    onCreateBranch: (String) -> Unit,
    onOpenBranchSelector: () -> Unit = {},
    onBranchPickerOpenChange: (Boolean) -> Unit = {},
    openPickerRequestKey: Int = 0,
    onOpenPickerRequestConsumed: () -> Unit = {},
    compact: Boolean = false,
    modifier: Modifier = Modifier,
) {
    var sheetOpen by rememberSaveable { mutableStateOf(false) }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    var createDialogOpen by rememberSaveable { mutableStateOf(false) }
    var newBranchName by rememberSaveable { mutableStateOf("") }
    var lastLoadedState by remember {
        mutableStateOf(state as? GitBranchPaneState.Loaded)
    }

    fun closeBranchPicker(cause: BranchPickerCloseCause) {
        sheetOpen = false
        searchQuery = ""
        createDialogOpen = false
        newBranchName = ""
        onBranchPickerOpenChange(false)
        if (shouldConsumeBranchPickerOpenRequest(cause)) {
            onOpenPickerRequestConsumed()
        }
    }

    LaunchedEffect(branchPickerEnabled, state) {
        if (state is GitBranchPaneState.Loaded) {
            lastLoadedState = state
        }
        if (state !is GitBranchPaneState.Loaded && state !is GitBranchPaneState.Loading) {
            lastLoadedState = null
        }
        val isTransientLoading = state is GitBranchPaneState.Loading
        val shouldCloseSheet =
            (!branchPickerEnabled && !isTransientLoading) ||
                (state !is GitBranchPaneState.Loaded && !isTransientLoading)
        if (shouldCloseSheet) {
            closeBranchPicker(BranchPickerCloseCause.StateInvalidated)
        }
    }

    LaunchedEffect(openPickerRequestKey) {
        if (openPickerRequestKey > 0 && branchPickerEnabled && state is GitBranchPaneState.Loaded) {
            searchQuery = ""
            sheetOpen = true
            onBranchPickerOpenChange(true)
            onOpenBranchSelector()
        }
    }

    if (compact && state !is GitBranchPaneState.Loaded && state !is GitBranchPaneState.Loading) {
        return
    }

    val sheetLoadedState = (state as? GitBranchPaneState.Loaded) ?: lastLoadedState
    if (sheetOpen && sheetLoadedState != null) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

        ModalBottomSheet(
            onDismissRequest = {
                closeBranchPicker(BranchPickerCloseCause.UserDismissed)
            },
            sheetState = sheetState,
        ) {
            if (createDialogOpen) {
                CreateBranchSheetContent(
                    branchName = newBranchName,
                    onBranchNameChange = { newBranchName = it },
                    existingBranches = sheetLoadedState.summary.branches,
                    currentBranch = sheetLoadedState.summary.currentBranch,
                    isSwitchingBranch = isSwitchingBranch || state is GitBranchPaneState.Loading,
                    onCancel = {
                        createDialogOpen = false
                        newBranchName = ""
                    },
                    onCreate = { branch ->
                        closeBranchPicker(BranchPickerCloseCause.BranchCreated)
                        onCreateBranch(branch)
                    },
                )
            } else {
                GitBranchPickerSheetContent(
                    summary = sheetLoadedState.summary,
                    searchQuery = searchQuery,
                    onSearchQueryChange = { searchQuery = it },
                    isSwitchingBranch = isSwitchingBranch || state is GitBranchPaneState.Loading,
                    onRefresh = {
                        onRefreshBranches()
                    },
                    onSelectBranch = { branch ->
                        closeBranchPicker(BranchPickerCloseCause.BranchSelected)
                        onCheckoutBranch(branch)
                    },
                    onOpenCreateBranch = {
                        newBranchName = ""
                        createDialogOpen = true
                    },
                )
            }
        }
    }

    when (state) {
        GitBranchPaneState.UnavailableNoProject ->
            MutedHint(
                text = stringResource(R.string.git_branch_unavailable_no_project),
                modifier = modifier,
            )

        GitBranchPaneState.AwaitingBridge ->
            MutedHint(
                text = stringResource(R.string.git_branch_awaiting_bridge),
                modifier = modifier,
            )

        GitBranchPaneState.Loading ->
            Row(
                modifier =
                    modifier
                        .fillMaxWidth()
                        .padding(horizontal = 4.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                )

                Text(
                    text = stringResource(R.string.git_branch_loading),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

        is GitBranchPaneState.Loaded ->
            if (compact) {
                LoadedGitBranchPill(
                    summary = state.summary,
                    branchPickerEnabled = branchPickerEnabled,
                    isSwitchingBranch = isSwitchingBranch,
                    onOpenPicker = {
                        onOpenBranchSelector()
                        sheetOpen = true
                        onBranchPickerOpenChange(true)
                    },
                    modifier = modifier,
                )
            } else {
                LoadedGitBranchStrip(
                    summary = state.summary,
                    branchPickerEnabled = branchPickerEnabled,
                    isSwitchingBranch = isSwitchingBranch,
                    onOpenPicker = {
                        onOpenBranchSelector()
                        sheetOpen = true
                        onBranchPickerOpenChange(true)
                    },
                    modifier = modifier,
                )
            }

        is GitBranchPaneState.Failed ->
            Text(
                text = state.message,
                modifier = modifier.padding(horizontal = 4.dp, vertical = 2.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
    }
}

@Composable
private fun MutedHint(
    text: String,
    modifier: Modifier = Modifier,
) {
    Text(
        text = text,
        modifier = modifier.padding(horizontal = 4.dp, vertical = 2.dp),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun LoadedGitBranchPill(
    summary: GitBranchDisplaySummary,
    branchPickerEnabled: Boolean,
    isSwitchingBranch: Boolean,
    onOpenPicker: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val unknown = stringResource(R.string.git_branch_placeholder_unknown)
    val branchName = summary.currentBranch ?: unknown
    val chrome = isAgentLightChrome()
    val pillShape = RoundedCornerShape(50)

    val pillFill =
        if (chrome) {
            AgentLightColors.Surface.copy(alpha = 0.93f)
        } else {
            MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f)
        }

    val outlineMod: Modifier =
        if (chrome) {
            Modifier.border(1.dp, MaterialTheme.colorScheme.outline, pillShape)
        } else {
            Modifier
        }

    val glyphTint =
        if (chrome) {
            AgentLightColors.IconMuted
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        }

    val labelTint =
        if (chrome) {
            AgentLightColors.TextSecondary
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        }

    val clickableMod =
        if (branchPickerEnabled) {
            Modifier.clickable(onClick = onOpenPicker)
        } else {
            Modifier
        }

    BoxWithConstraints(modifier = modifier) {
        Surface(
            shape = pillShape,
            color = pillFill,
            modifier =
                outlineMod
                    .then(clickableMod)
                    .height(30.dp)
                    .widthIn(max = maxWidth)
                    .align(Alignment.CenterEnd),
        ) {
            Row(
                modifier =
                    Modifier
                        .widthIn(max = maxWidth)
                        .padding(horizontal = 9.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Icon(
                    painter = painterResource(LucideR.drawable.lucide_ic_git_fork),
                    contentDescription = null,
                    modifier = Modifier.size(12.dp),
                    tint = glyphTint,
                )

                Text(
                    text = branchName,
                    modifier = Modifier.widthIn(max = 124.dp),
                    style = MaterialTheme.typography.labelSmall,
                    color = labelTint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    softWrap = false,
                )

                if (isSwitchingBranch) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(10.dp),
                        strokeWidth = 2.dp,
                    )
                } else {
                    Icon(
                        imageVector = Icons.Filled.ArrowDropDown,
                        contentDescription = null,
                        modifier = Modifier.size(13.dp),
                        tint = glyphTint,
                    )
                }
            }
        }
    }
}

@Composable
private fun LoadedGitBranchStrip(
    summary: GitBranchDisplaySummary,
    branchPickerEnabled: Boolean,
    isSwitchingBranch: Boolean,
    onOpenPicker: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val unknown = stringResource(R.string.git_branch_placeholder_unknown)
    val current = summary.currentBranch ?: unknown
    val defaultBr = summary.defaultBranch ?: unknown

    val dirtySuffix =
        if (summary.isDirty) {
            stringResource(R.string.git_branch_dirty_marker)
        } else {
            ""
        }

    val elsewhereSuffix =
        if (summary.branchesCheckedOutElsewhere.isEmpty()) {
            ""
        } else {
            stringResource(
                R.string.git_branch_elsewhere_suffix,
                summary.branchesCheckedOutElsewhere.size,
            )
        }

    val line =
        stringResource(
            R.string.git_branch_line_current_default,
            current,
            defaultBr,
        ) + dirtySuffix + elsewhereSuffix

    val cd =
        stringResource(
            R.string.git_branch_cd_loaded,
            current,
            defaultBr,
            summary.branchesCheckedOutElsewhere.size,
        )

    val stripModifier =
        if (branchPickerEnabled) {
            modifier
                .fillMaxWidth()
                .clickable(onClick = onOpenPicker)
        } else {
            modifier.fillMaxWidth()
        }

    val hintRunning = stringResource(R.string.git_branch_picker_disabled_running)
    val hintSwitching = stringResource(R.string.git_branch_switching_inline)

    val footerHint =
        when {
            isSwitchingBranch -> hintSwitching
            !branchPickerEnabled && summary.branches.isNotEmpty() -> hintRunning
            else -> null
        }

    Column(modifier = stripModifier) {
        Surface(
            shape = RoundedCornerShape(12.dp),
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f),
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    text = line,
                    modifier =
                        Modifier
                            .weight(1f)
                            .semantics { contentDescription = cd },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                if (branchPickerEnabled) {
                    Text(
                        text = stringResource(R.string.git_branch_tap_to_switch),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        }

        footerHint?.let {
            Text(
                text = it,
                modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
