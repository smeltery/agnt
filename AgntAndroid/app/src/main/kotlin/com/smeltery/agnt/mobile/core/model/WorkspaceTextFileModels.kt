package com.smeltery.agnt.mobile.core.model

data class WorkspaceTextFileMetadata(
    val path: String = "",
    val fileName: String = "",
    val byteLength: Long = 0L,
    val mtimeMs: Double = 0.0,
    val encoding: String = "",
)

data class WorkspaceTextFileReadResult(
    val metadata: WorkspaceTextFileMetadata = WorkspaceTextFileMetadata(),
    val content: String? = null,
    val lineCount: Int? = null,
    val notModified: Boolean = false,
) {
    val path: String get() = metadata.path
    val fileName: String get() = metadata.fileName
    val byteLength: Long get() = metadata.byteLength
    val mtimeMs: Double get() = metadata.mtimeMs
    val encoding: String get() = metadata.encoding

    companion object {
        fun fromJson(
            json: RPCObject,
            fallbackPath: String = "",
        ): WorkspaceTextFileReadResult {
            val path = json["path"]?.stringValue?.trim()?.takeIf { it.isNotEmpty() } ?: fallbackPath
            return WorkspaceTextFileReadResult(
                metadata =
                    WorkspaceTextFileMetadata(
                        path = path,
                        fileName = json["fileName"]?.stringValue?.trim().orEmpty(),
                        byteLength = json["byteLength"]?.longValue ?: 0L,
                        mtimeMs = json["mtimeMs"]?.doubleValue ?: 0.0,
                        encoding = json["encoding"]?.stringValue?.trim().orEmpty(),
                    ),
                content = json["content"]?.stringValue,
                lineCount = json["lineCount"]?.intValue,
                notModified = json["notModified"]?.boolValue ?: false,
            )
        }
    }
}
