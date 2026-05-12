package com.dotbrains.agnt.mobile.ui.design.data

import com.dotbrains.agnt.mobile.ui.design.DesignDocument
import com.dotbrains.agnt.mobile.ui.design.ExportResult
import com.dotbrains.agnt.mobile.ui.design.ExportTarget
import com.dotbrains.agnt.mobile.ui.design.GenerationState

interface DesignRepository {
    suspend fun generateDesign(
        projectId: String,
        prompt: String,
        target: String?,
    ): GenerationState

    suspend fun getGenerationStatus(generationId: String): GenerationState

    suspend fun getDocument(documentId: String): DesignDocument

    suspend fun editDocument(
        documentId: String,
        prompt: String,
        selectedNodeId: String?,
    ): GenerationState

    suspend fun exportDocument(
        documentId: String,
        target: ExportTarget,
    ): ExportResult
}
