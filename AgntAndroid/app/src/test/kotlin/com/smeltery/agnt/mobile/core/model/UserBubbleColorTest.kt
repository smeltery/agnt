package com.smeltery.agnt.mobile.core.model

import kotlin.test.Test
import kotlin.test.assertEquals

class UserBubbleColorTest {
    @Test
    fun defaultColorIsUsedForMissingOrInvalidStorage() {
        assertEquals(UserBubbleColor.default, UserBubbleColor.defaultValue)
        assertEquals(UserBubbleColor.default, UserBubbleColor.fromStorage(null))
        assertEquals(UserBubbleColor.default, UserBubbleColor.fromStorage(""))
        assertEquals(UserBubbleColor.default, UserBubbleColor.fromStorage("unknown"))
    }

    @Test
    fun allStoredColorsRoundTrip() {
        UserBubbleColor.entries.forEach { color ->
            assertEquals(color, UserBubbleColor.fromStorage(color.name))
        }
    }
}
