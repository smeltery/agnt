package com.dotbrains.agnt.mobile.services

import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.core.model.RPCMessage
import com.dotbrains.agnt.mobile.services.workspace.WorkspaceTextFileService
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class WorkspaceTextFileServiceTest {
    @Test
    fun readPreview_requestsContentAndUsesConditionalMetadata() =
        runTest {
            val capturedParams = mutableListOf<Map<String, JSONValue>>()
            val service =
                WorkspaceTextFileService(
                    MinimalSendRepository { method, params ->
                        assertEquals("workspace/readFile", method)
                        val objectParams = params?.objectValue.orEmpty()
                        capturedParams.add(objectParams)
                        val notModified = capturedParams.size == 2
                        RPCMessage.success(
                            id = JSONValue.NumLong(capturedParams.size.toLong()),
                            result =
                                JSONValue.Obj(
                                    mapOf(
                                        "path" to JSONValue.Str("/repo/src/Main.kt"),
                                        "fileName" to JSONValue.Str("Main.kt"),
                                        "byteLength" to JSONValue.NumLong(42),
                                        "mtimeMs" to JSONValue.NumDouble(123.5),
                                        "encoding" to JSONValue.Str("utf-8"),
                                        "lineCount" to JSONValue.NumLong(2),
                                        "notModified" to JSONValue.Bool(notModified),
                                    ) +
                                        if (notModified) {
                                            emptyMap()
                                        } else {
                                            mapOf("content" to JSONValue.Str("fun main() {}\n"))
                                        },
                                ),
                        )
                    },
                )

            val first = service.readPreview("src/Main.kt", cwd = "/repo")
            val second = service.readPreview("src/Main.kt", cwd = "/repo")

            assertEquals("fun main() {}\n", first.content)
            assertEquals(first.content, second.content)
            assertEquals(false, first.fromCache)
            assertEquals(true, second.fromCache)
            assertEquals("src/Main.kt", capturedParams.first()["path"]?.stringValue)
            assertEquals("/repo", capturedParams.first()["cwd"]?.stringValue)
            assertEquals(true, capturedParams.first()["includeContent"]?.boolValue)
            assertNull(capturedParams.first()["ifByteLength"])
            assertNull(capturedParams.first()["ifMtimeMs"])
            assertEquals(42L, capturedParams[1]["ifByteLength"]?.longValue)
            assertEquals(123.5, capturedParams[1]["ifMtimeMs"]?.doubleValue)
        }

    @Test
    fun readTextFile_parserKeepsFallbackPathWhenBridgeOmitsPath() =
        runTest {
            val service =
                WorkspaceTextFileService(
                    MinimalSendRepository { _, _ ->
                        RPCMessage.success(
                            id = JSONValue.NumLong(1),
                            result =
                                JSONValue.Obj(
                                    mapOf(
                                        "byteLength" to JSONValue.NumLong(3),
                                        "mtimeMs" to JSONValue.NumLong(9),
                                        "content" to JSONValue.Str("abc"),
                                    ),
                                ),
                        )
                    },
                )

            val result = service.readTextFile("README.md")

            assertEquals("README.md", result.path)
            assertEquals(3L, result.byteLength)
            assertEquals(9.0, result.mtimeMs)
            assertEquals("abc", result.content)
        }
}
