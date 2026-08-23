package com.smeltery.agnt.mobile.ui.shell

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.core.model.AIUnifiedPatchParser
import com.smeltery.agnt.mobile.core.model.GitRepoSyncResult
import com.smeltery.agnt.mobile.data.RepoDiffLastTurnFileRow
import com.smeltery.agnt.mobile.ui.turn.timeline.RepoMarkdownFileLink
import kotlinx.coroutines.delay
import com.composables.icons.lucide.R as LucideR

enum class GitRepoDiffScope {
    LastTurn,
    FullWorkingTree,
}

internal data class GitRepoDiffRenderableRow(
    val stableKey: String,
    val displayPath: String,
    val chunk: String,
)

internal enum class GitRepoDiffUiTab(
    val stringRes: Int,
) {
    Summary(R.string.git_repo_diff_tab_summary),
    Review(R.string.git_repo_diff_tab_review),
}

@OptIn(ExperimentalMaterial3Api::class)
@Suppress("LongMethod")
@Composable
fun GitRepoDiffBottomSheet(
    visible: Boolean,
    scope: GitRepoDiffScope,
    onScopeChange: (GitRepoDiffScope) -> Unit,
    lastTurnRows: List<RepoDiffLastTurnFileRow>,
    fullTreePatch: String,
    isFullTreeLoading: Boolean,
    fullTreeError: String?,
    gitStatus: GitRepoSyncResult?,
    focusPathQuery: String?,
    onFocusPathQueryConsumed: () -> Unit,
    onDismiss: () -> Unit,
) {
    if (!visible) return
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    LaunchedEffect(sheetState) {
        sheetState.expand()
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        var selectedTabIx by remember { mutableIntStateOf(GitRepoDiffUiTab.Review.ordinal) }
        val selectedTab =
            GitRepoDiffUiTab.entries.getOrElse(selectedTabIx) { GitRepoDiffUiTab.Review }

        val trimmedFull = remember(fullTreePatch) { fullTreePatch.trim() }
        val rows =
            remember(scope, trimmedFull, lastTurnRows) {
                when (scope) {
                    GitRepoDiffScope.LastTurn ->
                        lastTurnRows.map {
                            GitRepoDiffRenderableRow(
                                stableKey = it.stableKey,
                                displayPath = it.path,
                                chunk = it.chunk,
                            )
                        }
                    GitRepoDiffScope.FullWorkingTree ->
                        if (trimmedFull.isBlank()) {
                            emptyList()
                        } else {
                            AIUnifiedPatchParser.splitUnifiedPatchIntoFileChunks(trimmedFull).mapIndexed {
                                i,
                                pair,
                                ->
                                GitRepoDiffRenderableRow(
                                    stableKey = "full:$i:${pair.first}",
                                    displayPath = pair.first,
                                    chunk = pair.second,
                                )
                            }
                        }
                }
            }

        val reviewLazyListState = rememberLazyListState()
        var markdownExpandRowStableKey by remember { mutableStateOf<String?>(null) }
        val onFocusConsumedUpdated = rememberUpdatedState(onFocusPathQueryConsumed)

        LaunchedEffect(visible) {
            if (!visible) {
                markdownExpandRowStableKey = null
            }
        }

        LaunchedEffect(focusPathQuery, rows, trimmedFull, isFullTreeLoading, scope) {
            val q = focusPathQuery?.trim()?.takeIf { it.isNotEmpty() } ?: return@LaunchedEffect

            selectedTabIx = GitRepoDiffUiTab.Review.ordinal

            val waitingPatch =
                scope == GitRepoDiffScope.FullWorkingTree &&
                    trimmedFull.isBlank() &&
                    isFullTreeLoading
            if (waitingPatch) {
                return@LaunchedEffect
            }

            delay(48)

            val ix =
                rows.indexOfFirst {
                    RepoMarkdownFileLink.rowMatchesQuery(it.displayPath, q)
                }
            if (ix >= 0) {
                markdownExpandRowStableKey = rows[ix].stableKey
                reviewLazyListState.animateScrollToItem(ix)
                delay(50)
            } else {
                markdownExpandRowStableKey = null
            }
            onFocusConsumedUpdated.value()
        }

        val edits = remember { mutableStateMapOf<String, TextFieldValue>() }
        LaunchedEffect(scope) {
            edits.clear()
        }

        Column(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .fillMaxHeight(0.92f)
                    .padding(horizontal = 18.dp)
                    .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(R.string.git_repo_diff_sheet_title),
                    style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.SemiBold),
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onDismiss) {
                    Text(stringResource(android.R.string.ok))
                }
            }

            GitRepoDiffSegmentedTabs(
                selectedTab = selectedTab,
                onSelected = { selectedTabIx = it.ordinal },
            )

            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                GitRepoDiffScopePill(
                    selected = scope == GitRepoDiffScope.LastTurn,
                    onClick = {
                        edits.clear()
                        onScopeChange(GitRepoDiffScope.LastTurn)
                    },
                    iconRes = LucideR.drawable.lucide_ic_clock,
                    label = stringResource(R.string.git_repo_diff_scope_last_turn),
                )
                GitRepoDiffScopePill(
                    selected = scope == GitRepoDiffScope.FullWorkingTree,
                    onClick = {
                        edits.clear()
                        onScopeChange(GitRepoDiffScope.FullWorkingTree)
                    },
                    iconRes = LucideR.drawable.lucide_ic_git_branch,
                    label = stringResource(R.string.git_repo_diff_scope_full_tree),
                )
            }

            when {
                scope == GitRepoDiffScope.FullWorkingTree && fullTreeError != null ->
                    GitRepoDiffMessage(
                        text = fullTreeError,
                        isError = true,
                        modifier = Modifier.weight(1f),
                    )

                scope == GitRepoDiffScope.FullWorkingTree && isFullTreeLoading && fullTreePatch.isBlank() ->
                    Box(
                        modifier = Modifier.fillMaxWidth().weight(1f),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator()
                    }

                rows.isEmpty() && scope == GitRepoDiffScope.LastTurn ->
                    GitRepoDiffMessage(
                        text = stringResource(R.string.git_repo_diff_empty_last_turn),
                        modifier = Modifier.weight(1f),
                    )

                rows.isEmpty() ->
                    GitRepoDiffMessage(
                        text = stringResource(R.string.git_repo_diff_empty),
                        modifier = Modifier.weight(1f),
                    )

                else ->
                    GitRepoDiffContent(
                        uiTab = selectedTab,
                        rows = rows,
                        gitStatus = gitStatus,
                        edits = edits,
                        reviewLazyListState = reviewLazyListState,
                        markdownExpandRowStableKey = markdownExpandRowStableKey,
                        modifier =
                            Modifier
                                .fillMaxWidth()
                                .weight(1f),
                    )
            }
        }
    }
}
