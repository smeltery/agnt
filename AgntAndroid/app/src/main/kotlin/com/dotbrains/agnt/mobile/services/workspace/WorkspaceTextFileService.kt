package com.dotbrains.agnt.mobile.services.workspace

import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.core.model.RPCObject
import com.dotbrains.agnt.mobile.core.model.WorkspaceTextFileMetadata
import com.dotbrains.agnt.mobile.core.model.WorkspaceTextFileReadResult
import com.dotbrains.agnt.mobile.data.CodexRepository

class WorkspaceTextFileService(
    private val repository: CodexRepository,
) {
    data class TextPreview(
        val metadata: WorkspaceTextFileMetadata,
        val content: String,
        val lineCount: Int?,
        val fromCache: Boolean,
    )

    private data class CacheKey(
        val path: String,
        val cwd: String?,
    )

    private val previewCache = mutableMapOf<CacheKey, TextPreview>()

    suspend fun readTextFile(
        path: String,
        cwd: String? = null,
        cached: WorkspaceTextFileMetadata? = null,
    ): WorkspaceTextFileReadResult {
        val trimmedPath = path.trim()
        require(trimmedPath.isNotEmpty()) { "path must not be blank" }
        val params =
            linkedMapOf<String, JSONValue>(
                "path" to JSONValue.Str(trimmedPath),
                "includeContent" to JSONValue.Bool(true),
            )
        cwd?.trim()?.takeIf { it.isNotEmpty() }?.let { params["cwd"] = JSONValue.Str(it) }
        cached?.let {
            params["ifByteLength"] = JSONValue.NumLong(it.byteLength)
            params["ifMtimeMs"] = JSONValue.NumDouble(it.mtimeMs)
        }
        return WorkspaceTextFileReadResult.fromJson(send("workspace/readFile", params), trimmedPath)
    }

    suspend fun readPreview(
        path: String,
        cwd: String? = null,
    ): TextPreview {
        val trimmedPath = path.trim()
        require(trimmedPath.isNotEmpty()) { "path must not be blank" }
        val normalizedCwd = cwd?.trim()?.takeIf { it.isNotEmpty() }
        val key = CacheKey(trimmedPath, normalizedCwd)
        val cached = synchronized(previewCache) { previewCache[key] }
        val result = readTextFile(trimmedPath, normalizedCwd, cached?.metadata)
        if (result.notModified && cached != null) {
            return cached.copy(fromCache = true)
        }
        val content =
            result.content
                ?: error("Text file response did not include content.")
        val fresh =
            TextPreview(
                metadata = result.metadata,
                content = content,
                lineCount = result.lineCount,
                fromCache = false,
            )
        synchronized(previewCache) {
            previewCache[key] = fresh
            if (fresh.metadata.path.isNotBlank() && fresh.metadata.path != trimmedPath) {
                previewCache[CacheKey(fresh.metadata.path, normalizedCwd)] = fresh
            }
        }
        return fresh
    }

    private suspend fun send(
        method: String,
        params: RPCObject,
    ): RPCObject {
        val response =
            repository.sendRequest(
                method = method,
                params = JSONValue.Obj(params),
            )
        return response.result?.objectValue
            ?: error("Invalid response from bridge.")
    }
}
