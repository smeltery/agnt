package com.smeltery.agnt.mobile.services.agent.pet

import com.smeltery.agnt.mobile.core.model.JSONValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AgentServicePetsTest {
    private fun obj(vararg pairs: Pair<String, JSONValue>) = JSONValue.Obj(pairs.toMap())

    @Test
    fun parsesMetadataWithoutSpritesheet() {
        val pet =
            petCompanion(
                obj(
                    "id" to JSONValue.Str("custom:robot"),
                    "displayName" to JSONValue.Str("Robot"),
                    "folderName" to JSONValue.Str("robot"),
                    "description" to JSONValue.Str("A tin pal"),
                    "spritesheetByteLength" to JSONValue.NumLong(1234),
                ),
                requiresSpritesheetData = false,
            )
        assertEquals("custom:robot", pet?.id)
        assertEquals("Robot", pet?.displayName)
        assertEquals("robot", pet?.folderName)
        assertEquals(1234, pet?.spritesheetByteLength)
    }

    @Test
    fun rejectsMissingDataWhenRequired() {
        val pet =
            petCompanion(
                obj(
                    "id" to JSONValue.Str("custom:robot"),
                    "displayName" to JSONValue.Str("Robot"),
                ),
                requiresSpritesheetData = true,
            )
        assertNull(pet)
    }

    @Test
    fun keepsDataWhenPresent() {
        val pet =
            petCompanion(
                obj(
                    "id" to JSONValue.Str("custom:robot"),
                    "displayName" to JSONValue.Str("Robot"),
                    "spritesheetDataUrl" to JSONValue.Str("data:image/webp;base64,AAAA"),
                ),
                requiresSpritesheetData = true,
            )
        assertEquals("data:image/webp;base64,AAAA", pet?.spritesheetDataUrl)
    }

    @Test
    fun fallsBackFolderNameToId() {
        val pet =
            petCompanion(
                obj(
                    "id" to JSONValue.Str("custom:robot"),
                    "displayName" to JSONValue.Str("Robot"),
                ),
                requiresSpritesheetData = false,
            )
        assertEquals("custom:robot", pet?.folderName)
    }

    @Test
    fun rejectsBlankIdOrName() {
        assertNull(
            petCompanion(
                obj("id" to JSONValue.Str("  "), "displayName" to JSONValue.Str("Robot")),
                requiresSpritesheetData = false,
            ),
        )
        assertNull(
            petCompanion(
                obj("id" to JSONValue.Str("custom:robot"), "displayName" to JSONValue.Str("")),
                requiresSpritesheetData = false,
            ),
        )
    }
}
