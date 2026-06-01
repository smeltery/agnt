package com.dotbrains.agnt.mobile.ui.pet

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dotbrains.agnt.mobile.AppContainer
import com.dotbrains.agnt.mobile.data.PetCompanionStatusInputs
import com.dotbrains.agnt.mobile.data.PetCompanionStatusStore
import com.dotbrains.agnt.mobile.data.derivePetStatusSnapshot
import com.dotbrains.agnt.mobile.ui.LocalCodexRepository
import kotlinx.coroutines.delay

/**
 * Connects the [com.dotbrains.agnt.mobile.data.PetCompanionStore] to the bridge
 * and recomputes the status pill, then renders [PetCompanionOverlay] (parity iOS
 * `PetCompanionOverlay` + `PetCompanionStatusSyncView`).
 *
 * No-ops entirely when the pet is disabled. While work is running the status
 * snapshot is refreshed on a 1s cadence so the pill tracks the latest activity.
 */
@Composable
fun PetCompanionHost(
    bottomExclusionHeightDp: Float,
    isInteractionEnabled: Boolean,
    modifier: Modifier = Modifier,
) {
    val repository = LocalCodexRepository.current
    val store = AppContainer.petCompanionStore
    val statusStore = remember { PetCompanionStatusStore() }

    val isEnabled by store.isEnabled.collectAsStateWithLifecycle()
    val renderedPet by store.renderedPet.collectAsStateWithLifecycle()
    val position by store.position.collectAsStateWithLifecycle()
    val selectedPetId by store.selectedPetId.collectAsStateWithLifecycle()
    val status by statusStore.snapshot.collectAsStateWithLifecycle()

    val ready by repository.isSessionReady.collectAsStateWithLifecycle()
    val activeThreadId by repository.activeThreadId.collectAsStateWithLifecycle()
    val threads by repository.threads.collectAsStateWithLifecycle()
    val runningTurnByThread by repository.runningTurnIdByThread.collectAsStateWithLifecycle()
    val protectedRunningFallback by repository.protectedRunningFallbackThreadIds.collectAsStateWithLifecycle()
    val pendingApproval by repository.pendingApprovalRequest.collectAsStateWithLifecycle()
    val messagesByThread by repository.messagesByThread.collectAsStateWithLifecycle()

    // Load metadata + selected spritesheet when connected and enabled.
    LaunchedEffect(isEnabled, ready, selectedPetId) {
        if (!isEnabled || !ready) {
            statusStore.reset()
            if (!ready) store.reset()
            return@LaunchedEffect
        }
        store.loadPetsIfNeeded(repository)
        store.loadSelectedPet(repository)
    }

    val runningThreadIds =
        remember(runningTurnByThread, protectedRunningFallback) {
            runningTurnByThread.keys + protectedRunningFallback
        }

    // Recompute the pill from the pet-relevant state slice; poll while work runs.
    LaunchedEffect(
        isEnabled,
        ready,
        activeThreadId,
        runningThreadIds,
        pendingApproval,
        threads,
        messagesByThread,
    ) {
        if (!isEnabled) {
            statusStore.reset()
            return@LaunchedEffect
        }

        fun inputs() =
            PetCompanionStatusInputs(
                isConnected = ready,
                activeThreadId = activeThreadId,
                runningThreadIds = runningThreadIds,
                hasPendingApproval = pendingApproval != null,
                pendingApprovalThreadId = pendingApproval?.threadId,
                threads = threads,
                messagesByThread = messagesByThread,
            )
        statusStore.update(derivePetStatusSnapshot(inputs()))
        while (runningThreadIds.isNotEmpty()) {
            delay(1_000)
            statusStore.update(derivePetStatusSnapshot(inputs()))
        }
    }

    if (!isEnabled) return

    PetCompanionOverlay(
        pet = renderedPet,
        status = status,
        position = position,
        isInteractionEnabled = isInteractionEnabled,
        bottomExclusionHeightDp = bottomExclusionHeightDp,
        onPositionChanged = store::updatePosition,
        modifier = modifier,
    )
}
