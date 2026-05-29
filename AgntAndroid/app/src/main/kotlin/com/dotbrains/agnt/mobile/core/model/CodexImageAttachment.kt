package com.dotbrains.agnt.mobile.core.model

import kotlinx.serialization.Serializable
import java.util.UUID

@Serializable
data class CodexImageAttachment(
    val id: String = UUID.randomUUID().toString(),
    val thumbnailBase64JPEG: String,
    val payloadDataURL: String? = null,
    val sourceURL: String? = null,
)
