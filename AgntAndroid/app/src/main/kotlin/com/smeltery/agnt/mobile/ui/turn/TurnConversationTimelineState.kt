package com.smeltery.agnt.mobile.ui.turn

import android.util.Log
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.smeltery.agnt.mobile.BuildConfig
import com.smeltery.agnt.mobile.core.model.CodexMessage
import com.smeltery.agnt.mobile.core.model.ThreadHistoryPaginationState
import com.smeltery.agnt.mobile.data.CodexRepository
import com.smeltery.agnt.mobile.ui.turn.timeline.SmartScrollNavigationState
import com.smeltery.agnt.mobile.ui.turn.timeline.buildChatAnchors
import com.smeltery.agnt.mobile.ui.turn.timeline.buildSmartScrollNavigationState
import com.smeltery.agnt.mobile.ui.turn.timeline.shouldFollowTimelineBottom
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

private const val TIMELINE_INITIAL_RENDER_TAIL = 48
private const val TIMELINE_LOAD_EARLIER_PAGE = 80
private const val TIMELINE_STAGING_THRESHOLD = 72
private const val STARTUP_TRACE_TAG = "AgntStartup"
private const val SMART_SCROLL_FADE_JUMP_DISTANCE_ITEMS = 24
internal val TurnConversationMessageListTopPadding = 112.dp

internal data class TurnConversationTimelineState(
    val listState: LazyListState,
    val visibleMessages: List<CodexMessage>,
    val hiddenEarlierCount: Int,
    val canLoadOlderRemoteHistory: Boolean,
    val isLoadingOlderHistory: Boolean,
    val olderHistoryError: String?,
    val timelineContentAlpha: Float,
    val timelineBlurRadius: Dp,
    val smartScrollNavigationState: SmartScrollNavigationState,
    val onLoadEarlierMessages: (() -> Unit)?,
    val onSmartScrollNavigate: (Int) -> Unit,
)

@Composable
internal fun rememberTurnConversationTimelineState(
    threadId: String,
    repository: CodexRepository,
    scope: CoroutineScope,
    messages: List<CodexMessage>,
    historyPaginationByThread: Map<String, ThreadHistoryPaginationState>,
    loadingOlderHistoryThreadIds: Set<String>,
    olderHistoryErrorByThread: Map<String, String>,
): TurnConversationTimelineState {
    var visibleTailCount by rememberSaveable(threadId) { mutableIntStateOf(TIMELINE_INITIAL_RENDER_TAIL) }
    LaunchedEffect(threadId, messages.size) {
        if (messages.size <= TIMELINE_STAGING_THRESHOLD) {
            visibleTailCount = messages.size.coerceAtLeast(TIMELINE_INITIAL_RENDER_TAIL)
        } else if (visibleTailCount < TIMELINE_INITIAL_RENDER_TAIL) {
            visibleTailCount = TIMELINE_INITIAL_RENDER_TAIL
        }
        if (BuildConfig.DEBUG) {
            Log.d(
                STARTUP_TRACE_TAG,
                "timeline source thread=$threadId messages=${messages.size} visibleTail=$visibleTailCount",
            )
        }
    }
    val visibleMessages =
        remember(messages, visibleTailCount) {
            if (messages.size <= TIMELINE_STAGING_THRESHOLD) {
                messages
            } else {
                messages.takeLast(visibleTailCount.coerceAtMost(messages.size))
            }
        }
    val hiddenEarlierCount = (messages.size - visibleMessages.size).coerceAtLeast(0)
    val historyPaginationState = historyPaginationByThread[threadId]
    val canLoadOlderRemoteHistory = historyPaginationState?.canLoadOlder == true
    val isLoadingOlderHistory = threadId in loadingOlderHistoryThreadIds
    val olderHistoryError = olderHistoryErrorByThread[threadId]
    val listState = rememberLazyListState()
    val latestMessageId = visibleMessages.lastOrNull()?.id
    var lastAutoScrollThreadId by remember { mutableStateOf<String?>(null) }
    var shouldAutoFollowBottom by rememberSaveable(threadId) { mutableStateOf(true) }
    var timelineContentVisible by remember(threadId) { mutableStateOf(true) }
    val timelineContentAlpha by animateFloatAsState(
        targetValue = if (timelineContentVisible) 1f else 0.18f,
        label = "timeline-content-alpha",
    )
    val timelineBlurRadius by animateDpAsState(
        targetValue = if (timelineContentVisible) 0.dp else 10.dp,
        label = "timeline-content-blur",
    )
    val shouldFollowBottom by remember {
        derivedStateOf {
            shouldFollowTimelineBottom(
                totalItemsCount = listState.layoutInfo.totalItemsCount,
                lastVisibleItemIndex =
                    listState.layoutInfo.visibleItemsInfo
                        .lastOrNull()
                        ?.index,
            )
        }
    }
    val firstVisibleListItemIndex by remember {
        derivedStateOf { listState.firstVisibleItemIndex }
    }
    val lastVisibleListItemIndex by remember {
        derivedStateOf {
            listState.layoutInfo.visibleItemsInfo
                .lastOrNull()
                ?.index
        }
    }
    val totalListItemCount by remember {
        derivedStateOf { listState.layoutInfo.totalItemsCount }
    }
    val timelineListItemOffset =
        if (hiddenEarlierCount > 0 || canLoadOlderRemoteHistory) {
            1
        } else {
            0
        }
    val chatAnchors =
        remember(visibleMessages, timelineListItemOffset) {
            buildChatAnchors(
                messages = visibleMessages,
                listItemOffset = timelineListItemOffset,
            )
        }
    val smartScrollNavigationState =
        remember(
            totalListItemCount,
            firstVisibleListItemIndex,
            lastVisibleListItemIndex,
            chatAnchors,
            shouldFollowBottom,
            latestMessageId,
        ) {
            buildSmartScrollNavigationState(
                totalItemsCount = totalListItemCount,
                firstVisibleItemIndex = firstVisibleListItemIndex,
                lastVisibleItemIndex = lastVisibleListItemIndex,
                anchors = chatAnchors,
                isNearBottom = shouldFollowBottom,
            )
        }
    LaunchedEffect(threadId) {
        lastAutoScrollThreadId = threadId
        if (visibleMessages.isNotEmpty()) {
            listState.scrollToItem(visibleMessages.lastIndex)
            if (BuildConfig.DEBUG) {
                Log.d(
                    STARTUP_TRACE_TAG,
                    "timeline scrolled thread=$threadId visible=${visibleMessages.size} hiddenEarlier=$hiddenEarlierCount reason=thread",
                )
            }
        }
    }
    LaunchedEffect(threadId, listState) {
        snapshotFlow { shouldFollowBottom to listState.isScrollInProgress }
            .distinctUntilChanged()
            .collect { (isAtBottom, isScrolling) ->
                if (isScrolling) {
                    shouldAutoFollowBottom = isAtBottom
                }
            }
    }
    LaunchedEffect(latestMessageId, shouldFollowBottom) {
        if (shouldFollowBottom) {
            shouldAutoFollowBottom = true
        }
    }
    LaunchedEffect(latestMessageId, visibleMessages.size, shouldAutoFollowBottom) {
        if (visibleMessages.isNotEmpty() && shouldAutoFollowBottom && lastAutoScrollThreadId == threadId) {
            listState.animateScrollToItem(visibleMessages.lastIndex)
            if (BuildConfig.DEBUG) {
                Log.d(
                    STARTUP_TRACE_TAG,
                    "timeline scrolled thread=$threadId visible=${visibleMessages.size} hiddenEarlier=$hiddenEarlierCount reason=followBottom",
                )
            }
        }
    }

    val onLoadEarlierMessages: (() -> Unit)? =
        if (hiddenEarlierCount > 0 || canLoadOlderRemoteHistory) {
            {
                if (canLoadOlderRemoteHistory && hiddenEarlierCount <= TIMELINE_LOAD_EARLIER_PAGE) {
                    scope.launch { runCatching { repository.loadOlderThreadHistory(threadId) } }
                } else {
                    visibleTailCount =
                        (visibleTailCount + TIMELINE_LOAD_EARLIER_PAGE)
                            .coerceAtMost(messages.size)
                    if (BuildConfig.DEBUG) {
                        Log.d(
                            STARTUP_TRACE_TAG,
                            "timeline loadEarlier thread=$threadId visibleTail=$visibleTailCount total=${messages.size}",
                        )
                    }
                }
            }
        } else {
            null
        }
    val onSmartScrollNavigate: (Int) -> Unit = { requestedIndex ->
        val targetIndex =
            requestedIndex.coerceIn(
                minimumValue = 0,
                maximumValue = (listState.layoutInfo.totalItemsCount - 1).coerceAtLeast(0),
            )
        scope.launch {
            val distanceItems = kotlin.math.abs(targetIndex - listState.firstVisibleItemIndex)
            if (distanceItems >= SMART_SCROLL_FADE_JUMP_DISTANCE_ITEMS) {
                timelineContentVisible = false
                delay(90L)
                listState.scrollToItem(targetIndex)
                delay(120L)
                timelineContentVisible = true
            } else {
                listState.animateScrollToItem(targetIndex)
            }
            shouldAutoFollowBottom = targetIndex >= (listState.layoutInfo.totalItemsCount - 1).coerceAtLeast(0)
        }
    }

    return TurnConversationTimelineState(
        listState = listState,
        visibleMessages = visibleMessages,
        hiddenEarlierCount = hiddenEarlierCount,
        canLoadOlderRemoteHistory = canLoadOlderRemoteHistory,
        isLoadingOlderHistory = isLoadingOlderHistory,
        olderHistoryError = olderHistoryError,
        timelineContentAlpha = timelineContentAlpha,
        timelineBlurRadius = timelineBlurRadius,
        smartScrollNavigationState = smartScrollNavigationState,
        onLoadEarlierMessages = onLoadEarlierMessages,
        onSmartScrollNavigate = onSmartScrollNavigate,
    )
}
