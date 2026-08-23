package com.smeltery.agnt.mobile.ui.pet

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.smeltery.agnt.mobile.core.model.PetCompanion
import com.smeltery.agnt.mobile.core.model.PetCompanionLayout
import com.smeltery.agnt.mobile.core.model.PetCompanionPhase
import com.smeltery.agnt.mobile.core.model.PetCompanionPosition
import com.smeltery.agnt.mobile.core.model.PetCompanionStatusSnapshot
import kotlinx.coroutines.delay
import androidx.compose.foundation.Image as ComposeImage

private val SPRITE_SIZE = 92.dp
private val COMPANION_WIDTH = 176.dp
private val COMPANION_HEIGHT = 150.dp

/**
 * Draggable, animated companion pet drawn above the app shell (parity iOS
 * `PetCompanionOverlay`). The pet is positioned from a normalized anchor, can be
 * dragged to a new resting spot, and reacts to a tap with a jump.
 *
 * Rendering is a pure atlas lookup: [PetSpriteAtlas] crops 192x208 cells out of
 * the decoded spritesheet, the animation loop advances the frame index, and the
 * status pill mirrors the running/waiting/idle phase.
 */
@Composable
fun PetCompanionOverlay(
    pet: PetCompanion?,
    status: PetCompanionStatusSnapshot,
    position: PetCompanionPosition,
    isInteractionEnabled: Boolean,
    bottomExclusionHeightDp: Float,
    onPositionChanged: (PetCompanionPosition) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (pet?.spritesheetDataUrl.isNullOrEmpty()) return

    val density = LocalDensity.current
    var transientPhase by remember { mutableStateOf<PetCompanionPhase?>(null) }
    var dragPhase by remember { mutableStateOf(PetCompanionPhase.RunningRight) }
    var isDragging by remember { mutableStateOf(false) }

    BoxWithSize(modifier = modifier.fillMaxSize()) { containerWidthPx, containerHeightPx ->
        val petWidthPx = with(density) { COMPANION_WIDTH.toPx() }
        val petHeightPx = with(density) { COMPANION_HEIGHT.toPx() }
        val bottomExclusionPx = with(density) { bottomExclusionHeightDp.dp.toPx() }

        // Top-left pixel offset of the pet box. Plain mutable state so the drag
        // handler (non-suspend) can update it directly; re-anchored from the saved
        // normalized position whenever it or the container changes.
        var offsetX by remember { mutableFloatStateOf(Float.NaN) }
        var offsetY by remember { mutableFloatStateOf(Float.NaN) }

        LaunchedEffect(position, containerWidthPx, containerHeightPx, isDragging) {
            if (isDragging) return@LaunchedEffect
            val (x, y) =
                PetCompanionLayout.point(
                    position = position,
                    containerWidth = containerWidthPx,
                    containerHeight = containerHeightPx,
                    petWidth = petWidthPx,
                    petHeight = petHeightPx,
                    leftExclusionWidth = 0f,
                    bottomExclusionHeight = bottomExclusionPx,
                )
            offsetX = x - petWidthPx / 2f
            offsetY = y - petHeightPx / 2f
        }

        val currentPhase =
            when {
                isDragging -> dragPhase
                transientPhase != null -> transientPhase!!
                else -> status.phase
            }

        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp),
            modifier =
                Modifier
                    .size(width = COMPANION_WIDTH, height = COMPANION_HEIGHT)
                    .offsetPx(offsetX, offsetY)
                    .then(
                        if (isInteractionEnabled) {
                            Modifier
                                .pointerInput(containerWidthPx, containerHeightPx) {
                                    detectDragGestures(
                                        onDragStart = { isDragging = true },
                                        onDragEnd = {
                                            isDragging = false
                                            val centerX = offsetX + petWidthPx / 2f
                                            val centerY = offsetY + petHeightPx / 2f
                                            onPositionChanged(
                                                PetCompanionLayout.normalizedPosition(
                                                    x = centerX,
                                                    y = centerY,
                                                    containerWidth = containerWidthPx,
                                                    containerHeight = containerHeightPx,
                                                    petWidth = petWidthPx,
                                                    petHeight = petHeightPx,
                                                    leftExclusionWidth = 0f,
                                                    bottomExclusionHeight = bottomExclusionPx,
                                                ),
                                            )
                                        },
                                    ) { change, dragAmount ->
                                        change.consume()
                                        if (kotlin.math.abs(dragAmount.x) >= 4f) {
                                            dragPhase =
                                                if (dragAmount.x >= 0f) {
                                                    PetCompanionPhase.RunningRight
                                                } else {
                                                    PetCompanionPhase.RunningLeft
                                                }
                                        }
                                        val centerX = offsetX + petWidthPx / 2f + dragAmount.x
                                        val centerY = offsetY + petHeightPx / 2f + dragAmount.y
                                        val (cx, cy) =
                                            PetCompanionLayout.clampedPoint(
                                                x = centerX,
                                                y = centerY,
                                                containerWidth = containerWidthPx,
                                                containerHeight = containerHeightPx,
                                                petWidth = petWidthPx,
                                                petHeight = petHeightPx,
                                                leftExclusionWidth = 0f,
                                                bottomExclusionHeight = bottomExclusionPx,
                                            )
                                        offsetX = cx - petWidthPx / 2f
                                        offsetY = cy - petHeightPx / 2f
                                    }
                                }.pointerInput(Unit) {
                                    detectTapGestures(onTap = { transientPhase = PetCompanionPhase.Jumping })
                                }
                        } else {
                            Modifier
                        },
                    ),
        ) {
            PetSprite(
                pet = pet,
                phase = currentPhase,
                modifier = Modifier.size(SPRITE_SIZE, 100.dp),
            )

            AnimatedVisibility(visible = status.showsLabel) {
                StatusPill(title = status.title, detail = status.detail)
            }
        }

        // Auto-clear the tap jump after one short burst.
        LaunchedEffect(transientPhase) {
            if (transientPhase != null) {
                delay(850)
                transientPhase = null
            }
        }
    }
}

@Composable
private fun StatusPill(
    title: String?,
    detail: String?,
) {
    Surface(
        shape = RoundedCornerShape(percent = 50),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.92f),
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier =
                Modifier
                    .widthIn(max = 168.dp)
                    .padding(horizontal = 10.dp, vertical = 5.dp),
        ) {
            if (!title.isNullOrEmpty()) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                )
            }
            if (!detail.isNullOrEmpty()) {
                Text(
                    text = detail,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
private fun PetSprite(
    pet: PetCompanion,
    phase: PetCompanionPhase,
    modifier: Modifier = Modifier,
) {
    val atlas = remember(pet.spritesheetDataUrl ?: pet.id) { PetSpriteAtlas.decode(pet.spritesheetDataUrl) }
    var displayedPhase by remember(atlas) { mutableStateOf(PetCompanionPhase.Idle) }
    var frameIndex by remember(atlas) { mutableStateOf(0) }

    LaunchedEffect(phase, atlas) {
        if (atlas == null) return@LaunchedEffect
        displayedPhase = phase
        frameIndex = 0
        // Play the active phase a few times, then settle into a slow idle loop.
        if (phase != PetCompanionPhase.Idle) {
            repeat(3) {
                playPhaseOnce(phase, phase.frameDurationsMillis) {
                    displayedPhase = phase
                    frameIndex = it
                }
            }
            displayedPhase = PetCompanionPhase.Idle
            frameIndex = 0
        }
        while (true) {
            playPhaseOnce(
                PetCompanionPhase.Idle,
                PetCompanionPhase.Idle.slowFrameDurationsMillis,
            ) {
                displayedPhase = PetCompanionPhase.Idle
                frameIndex = it
            }
        }
    }

    val frame: ImageBitmap? =
        atlas?.frame(displayedPhase, frameIndex) ?: atlas?.frame(PetCompanionPhase.Idle, 0)
    if (frame != null) {
        ComposeImage(
            bitmap = frame,
            contentDescription = "${pet.displayName} companion pet",
            contentScale = ContentScale.Fit,
            modifier = modifier,
        )
    }
}

private suspend inline fun playPhaseOnce(
    phase: PetCompanionPhase,
    durations: List<Long>,
    setFrame: (Int) -> Unit,
) {
    for (index in 0 until phase.frameCount) {
        setFrame(index)
        delay(durations[index % durations.size])
    }
}

/** Crops and caches 192x208 atlas cells into [ImageBitmap] frames. */
private class PetSpriteAtlas private constructor(
    private val source: Bitmap,
) {
    private val cache = HashMap<String, ImageBitmap>()

    fun frame(
        phase: PetCompanionPhase,
        index: Int,
    ): ImageBitmap? {
        val normalized = index % maxOf(phase.frameCount, 1)
        val key = "${phase.rowIndex}:$normalized"
        cache[key]?.let { return it }
        val x = normalized * PetCompanionPhase.CELL_WIDTH
        val y = phase.rowIndex * PetCompanionPhase.CELL_HEIGHT
        if (x + PetCompanionPhase.CELL_WIDTH > source.width || y + PetCompanionPhase.CELL_HEIGHT > source.height) {
            return null
        }
        val cropped =
            Bitmap.createBitmap(source, x, y, PetCompanionPhase.CELL_WIDTH, PetCompanionPhase.CELL_HEIGHT)
        val image = cropped.asImageBitmap()
        cache[key] = image
        return image
    }

    companion object {
        fun decode(dataUrl: String?): PetSpriteAtlas? {
            val bitmap = decodeBitmap(dataUrl) ?: return null
            return PetSpriteAtlas(bitmap)
        }

        private fun decodeBitmap(dataUrl: String?): Bitmap? {
            if (dataUrl.isNullOrEmpty()) return null
            val comma = dataUrl.indexOf(',')
            if (comma < 0) return null
            val base64 = dataUrl.substring(comma + 1)
            return runCatching {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            }.getOrNull()
        }
    }
}

/** Reports container size in pixels to the content lambda. */
@Composable
private fun BoxWithSize(
    modifier: Modifier = Modifier,
    content: @Composable (widthPx: Float, heightPx: Float) -> Unit,
) {
    androidx.compose.foundation.layout.BoxWithConstraints(modifier = modifier) {
        val density = LocalDensity.current
        val widthPx = with(density) { maxWidth.toPx() }
        val heightPx = with(density) { maxHeight.toPx() }
        if (widthPx > 0f && heightPx > 0f) {
            content(widthPx, heightPx)
        }
    }
}

/** Pixel-space offset modifier (avoids dp round-tripping the animated value). */
private fun Modifier.offsetPx(
    x: Float,
    y: Float,
): Modifier =
    this.then(
        Modifier.layout { measurable, constraints ->
            val placeable = measurable.measure(constraints)
            layout(placeable.width, placeable.height) {
                placeable.placeRelative(x.toInt(), y.toInt())
            }
        },
    )
