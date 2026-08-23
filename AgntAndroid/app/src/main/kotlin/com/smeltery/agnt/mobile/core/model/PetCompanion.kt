package com.smeltery.agnt.mobile.core.model

import kotlin.math.max
import kotlin.math.min

/**
 * Local companion pet package loaded from the paired Mac through the bridge
 * (parity [PetCompanionModels.swift](CodexMobile/CodexMobile/Features/Pet/PetCompanionModels.swift)).
 *
 * The spritesheet is a single base64 data URL describing a 1536x1872 atlas of
 * 192x208 cells; [PetCompanionPhase] maps animation phases onto atlas rows.
 */
data class PetCompanion(
    val id: String,
    val folderName: String,
    val displayName: String,
    val description: String? = null,
    val spritesheetDataUrl: String? = null,
    val spritesheetMimeType: String? = null,
    val spritesheetByteLength: Int? = null,
)

/**
 * Animation phases shared with the bridge atlas layout. Row/frame counts and
 * per-frame durations are kept byte-identical to iOS so the same `~/.codex/pets`
 * spritesheets render the same way on both clients.
 */
enum class PetCompanionPhase(
    val wireValue: String,
) {
    Idle("idle"),
    RunningRight("running-right"),
    RunningLeft("running-left"),
    Waving("waving"),
    Jumping("jumping"),
    Failed("failed"),
    Waiting("waiting"),
    Running("running"),
    Review("review"),
    ;

    val rowIndex: Int
        get() =
            when (this) {
                Idle -> 0
                RunningRight -> 1
                RunningLeft -> 2
                Waving -> 3
                Jumping -> 4
                Failed -> 5
                Waiting -> 6
                Running -> 7
                Review -> 8
            }

    val frameCount: Int
        get() =
            when (this) {
                Idle -> 6
                RunningRight, RunningLeft, Failed -> 8
                Waving -> 4
                Jumping -> 5
                Waiting, Running, Review -> 6
            }

    /** Per-frame durations in milliseconds. */
    val frameDurationsMillis: List<Long>
        get() =
            when (this) {
                Idle -> listOf(280, 110, 110, 140, 140, 320)
                RunningRight, RunningLeft -> listOf(120, 120, 120, 120, 120, 120, 120, 220)
                Waving -> listOf(140, 140, 140, 280)
                Jumping -> listOf(140, 140, 140, 140, 280)
                Failed -> listOf(140, 140, 140, 140, 140, 140, 140, 240)
                Waiting -> listOf(150, 150, 150, 150, 150, 260)
                Running -> listOf(120, 120, 120, 120, 120, 220)
                Review -> listOf(150, 150, 150, 150, 150, 280)
            }

    /** Slowed idle loop so a resting pet doesn't flicker. */
    val slowFrameDurationsMillis: List<Long>
        get() = frameDurationsMillis.map { it * 6 }

    companion object {
        const val CELL_WIDTH = 192
        const val CELL_HEIGHT = 208
        const val ATLAS_COLUMNS = 8
    }
}

/** Normalized 0..1 anchor for the pet inside its container. */
data class PetCompanionPosition(
    val normalizedX: Double,
    val normalizedY: Double,
) {
    companion object {
        val Default = PetCompanionPosition(normalizedX = 0.82, normalizedY = 0.72)
    }
}

/** Resolved status pill content shown above the pet. */
data class PetCompanionStatusSnapshot(
    val phase: PetCompanionPhase,
    val title: String? = null,
    val detail: String? = null,
) {
    val showsLabel: Boolean
        get() = title != null || detail != null

    companion object {
        val Idle = PetCompanionStatusSnapshot(phase = PetCompanionPhase.Idle)
    }
}

/**
 * Pure geometry helpers (parity iOS `PetCompanionLayout`). Coordinates are pixel
 * points inside the container; margins keep the pet fully on-screen and out of
 * the bottom composer exclusion band.
 */
object PetCompanionLayout {
    fun point(
        position: PetCompanionPosition,
        containerWidth: Float,
        containerHeight: Float,
        petWidth: Float,
        petHeight: Float,
        leftExclusionWidth: Float,
        bottomExclusionHeight: Float,
    ): Pair<Float, Float> {
        val raw =
            (containerWidth * position.normalizedX.toFloat()) to
                (containerHeight * position.normalizedY.toFloat())
        return clampedPoint(
            x = raw.first,
            y = raw.second,
            containerWidth = containerWidth,
            containerHeight = containerHeight,
            petWidth = petWidth,
            petHeight = petHeight,
            leftExclusionWidth = leftExclusionWidth,
            bottomExclusionHeight = bottomExclusionHeight,
        )
    }

    fun normalizedPosition(
        x: Float,
        y: Float,
        containerWidth: Float,
        containerHeight: Float,
        petWidth: Float,
        petHeight: Float,
        leftExclusionWidth: Float,
        bottomExclusionHeight: Float,
    ): PetCompanionPosition {
        if (containerWidth <= 0f || containerHeight <= 0f) return PetCompanionPosition.Default
        val clamped =
            clampedPoint(
                x = x,
                y = y,
                containerWidth = containerWidth,
                containerHeight = containerHeight,
                petWidth = petWidth,
                petHeight = petHeight,
                leftExclusionWidth = leftExclusionWidth,
                bottomExclusionHeight = bottomExclusionHeight,
            )
        return PetCompanionPosition(
            normalizedX = (clamped.first / containerWidth).toDouble(),
            normalizedY = (clamped.second / containerHeight).toDouble(),
        )
    }

    fun clampedPoint(
        x: Float,
        y: Float,
        containerWidth: Float,
        containerHeight: Float,
        petWidth: Float,
        petHeight: Float,
        leftExclusionWidth: Float,
        bottomExclusionHeight: Float,
    ): Pair<Float, Float> {
        if (containerWidth <= 0f || containerHeight <= 0f) return 0f to 0f
        val horizontalMargin = max(12f, petWidth / 2f)
        val verticalMargin = max(12f, petHeight / 2f)
        val minX = min(containerWidth - horizontalMargin, leftExclusionWidth + horizontalMargin)
        val maxX = max(minX, containerWidth - horizontalMargin)
        val minY = verticalMargin
        val maxY = max(minY, containerHeight - bottomExclusionHeight - verticalMargin)
        return min(max(x, minX), maxX) to min(max(y, minY), maxY)
    }
}
