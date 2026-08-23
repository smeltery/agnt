package com.smeltery.agnt.mobile.core.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PetCompanionTest {
    @Test
    fun phaseRowsAreUniqueAndAtlasFits() {
        val rows = PetCompanionPhase.entries.map { it.rowIndex }
        assertEquals(rows.size, rows.toSet().size, "row indices must be unique")
        // 9 rows (0..8) at 208px = 1872; 8 columns at 192px = 1536. Matches the bridge atlas.
        assertEquals(8, PetCompanionPhase.entries.maxOf { it.rowIndex })
        assertTrue(PetCompanionPhase.entries.all { it.frameCount <= PetCompanionPhase.ATLAS_COLUMNS })
    }

    @Test
    fun frameDurationsMatchFrameCount() {
        for (phase in PetCompanionPhase.entries) {
            assertEquals(
                phase.frameCount,
                phase.frameDurationsMillis.size,
                "duration count must match frame count for $phase",
            )
        }
    }

    @Test
    fun slowDurationsAreSixTimesFast() {
        val idle = PetCompanionPhase.Idle
        assertEquals(idle.frameDurationsMillis.map { it * 6 }, idle.slowFrameDurationsMillis)
    }

    @Test
    fun pointThenNormalizedRoundTrips() {
        val container = 1000f to 2000f
        val position = PetCompanionPosition(normalizedX = 0.5, normalizedY = 0.4)
        val (x, y) =
            PetCompanionLayout.point(
                position = position,
                containerWidth = container.first,
                containerHeight = container.second,
                petWidth = 100f,
                petHeight = 100f,
                leftExclusionWidth = 0f,
                bottomExclusionHeight = 0f,
            )
        val back =
            PetCompanionLayout.normalizedPosition(
                x = x,
                y = y,
                containerWidth = container.first,
                containerHeight = container.second,
                petWidth = 100f,
                petHeight = 100f,
                leftExclusionWidth = 0f,
                bottomExclusionHeight = 0f,
            )
        assertEquals(0.5, back.normalizedX, 0.001)
        assertEquals(0.4, back.normalizedY, 0.001)
    }

    @Test
    fun clampKeepsPetOnScreenAndAboveExclusion() {
        val (x, y) =
            PetCompanionLayout.clampedPoint(
                x = 9999f,
                y = 9999f,
                containerWidth = 1000f,
                containerHeight = 1000f,
                petWidth = 100f,
                petHeight = 100f,
                leftExclusionWidth = 0f,
                bottomExclusionHeight = 200f,
            )
        // Right/bottom clamped by half-pet margin and the bottom exclusion band.
        assertEquals(950f, x)
        assertEquals(750f, y)
    }

    @Test
    fun degenerateContainerFallsBackToDefault() {
        val pos =
            PetCompanionLayout.normalizedPosition(
                x = 10f,
                y = 10f,
                containerWidth = 0f,
                containerHeight = 0f,
                petWidth = 100f,
                petHeight = 100f,
                leftExclusionWidth = 0f,
                bottomExclusionHeight = 0f,
            )
        assertEquals(PetCompanionPosition.Default, pos)
    }
}
