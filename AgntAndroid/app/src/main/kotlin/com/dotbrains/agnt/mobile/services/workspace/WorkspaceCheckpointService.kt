package com.dotbrains.agnt.mobile.services.workspace

import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.core.model.RPCObject
import com.dotbrains.agnt.mobile.core.model.WorkspaceCheckpointCaptureResult
import com.dotbrains.agnt.mobile.core.model.WorkspaceCheckpointCopyResult
import com.dotbrains.agnt.mobile.core.model.WorkspaceCheckpointDiffResult
import com.dotbrains.agnt.mobile.core.model.WorkspaceCheckpointRestoreApplyResult
import com.dotbrains.agnt.mobile.core.model.WorkspaceCheckpointRestorePreviewResult
import com.dotbrains.agnt.mobile.data.CodexRepository

class WorkspaceCheckpointService(
    private val repository: CodexRepository,
) {
    suspend fun capture(params: RPCObject): WorkspaceCheckpointCaptureResult = WorkspaceCheckpointCaptureResult.fromJson(send("workspace/checkpointCapture", params))

    suspend fun copy(params: RPCObject): WorkspaceCheckpointCopyResult = WorkspaceCheckpointCopyResult.fromJson(send("workspace/checkpointCopy", params))

    suspend fun diff(params: RPCObject): WorkspaceCheckpointDiffResult = WorkspaceCheckpointDiffResult.fromJson(send("workspace/checkpointDiff", params))

    suspend fun restorePreview(params: RPCObject): WorkspaceCheckpointRestorePreviewResult = WorkspaceCheckpointRestorePreviewResult.fromJson(send("workspace/checkpointRestorePreview", params))

    suspend fun restoreApply(params: RPCObject): WorkspaceCheckpointRestoreApplyResult = WorkspaceCheckpointRestoreApplyResult.fromJson(send("workspace/checkpointRestoreApply", params))

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
