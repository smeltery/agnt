package com.smeltery.agnt.mobile.ui.turn

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.core.content.ContextCompat
import com.smeltery.agnt.mobile.core.model.CodexFileAttachment
import com.smeltery.agnt.mobile.core.model.CodexImageAttachment
import com.smeltery.agnt.mobile.data.TurnAttachmentCodec
import com.smeltery.agnt.mobile.data.TurnFileAttachmentCodec
import com.smeltery.agnt.mobile.ui.turn.attachments.TurnComposerAttachment
import com.smeltery.agnt.mobile.ui.turn.attachments.toJpegByteArray
import com.smeltery.agnt.mobile.ui.turn.attachments.withFileAttachmentResult
import com.smeltery.agnt.mobile.ui.turn.attachments.withImageAttachmentResult
import com.smeltery.agnt.mobile.ui.turn.attachments.withLoadingAttachment
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

internal data class TurnAttachmentLaunchActions(
    val pickImages: () -> Unit,
    val pickFiles: () -> Unit,
    val takePhoto: () -> Unit,
)

@Composable
internal fun rememberTurnAttachmentLaunchActions(
    context: Context,
    scope: CoroutineScope,
    attachments: List<TurnComposerAttachment>,
    updateAttachments: ((List<TurnComposerAttachment>) -> List<TurnComposerAttachment>) -> Unit,
    setLastError: (String) -> Unit,
    attachmentsAllowed: Boolean,
    attachmentsBlockedMessage: String,
    maxAttachments: Int,
    maxNonImageAttachmentBytes: Int,
    maxNonImageAttachmentTextChars: Int,
    attachmentLimitMessage: String,
    attachmentOverflowMessage: String,
    attachmentLoadFailedMessage: String,
    attachmentFileTooLargeMessage: String,
    attachmentCameraUnavailableMessage: String,
    attachmentCameraPermissionDeniedMessage: String,
): TurnAttachmentLaunchActions {
    fun remainingAttachmentSlots(): Int = (maxAttachments - attachments.size).coerceAtLeast(0)

    fun appendLoadingAttachment(): String =
        UUID.randomUUID().toString().also { attachmentId ->
            updateAttachments { it.withLoadingAttachment(attachmentId) }
        }

    fun updateImageAttachmentResult(
        attachmentId: String,
        attachment: CodexImageAttachment?,
    ) {
        updateAttachments {
            it.withImageAttachmentResult(
                attachmentId = attachmentId,
                attachment = attachment,
                failedMessage = attachmentLoadFailedMessage,
            )
        }
        if (attachment == null) {
            setLastError(attachmentLoadFailedMessage)
        }
    }

    fun updateFileAttachmentResult(
        attachmentId: String,
        attachment: CodexFileAttachment?,
        errorMessage: String?,
    ) {
        val resolvedErrorMessage = errorMessage ?: attachmentLoadFailedMessage
        updateAttachments {
            it.withFileAttachmentResult(
                attachmentId = attachmentId,
                attachment = attachment,
                failedMessage = resolvedErrorMessage,
            )
        }
        if (attachment == null) {
            setLastError(resolvedErrorMessage)
        }
    }

    val photoPickerLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
            if (uris.isEmpty()) return@rememberLauncherForActivityResult
            val remainingSlots = remainingAttachmentSlots()
            if (remainingSlots <= 0) {
                setLastError(attachmentLimitMessage)
                return@rememberLauncherForActivityResult
            }
            val acceptedUris = uris.take(remainingSlots)
            if (acceptedUris.size < uris.size) {
                setLastError(attachmentOverflowMessage)
            }
            acceptedUris.forEach { uri ->
                val attachmentId = appendLoadingAttachment()
                scope.launch {
                    val attachment =
                        withContext(Dispatchers.IO) {
                            TurnAttachmentCodec.makeAttachment(context, uri)
                        }
                    updateImageAttachmentResult(attachmentId, attachment)
                }
            }
        }

    val filePickerLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
            if (uris.isEmpty()) return@rememberLauncherForActivityResult
            val remainingSlots = remainingAttachmentSlots()
            if (remainingSlots <= 0) {
                setLastError(attachmentLimitMessage)
                return@rememberLauncherForActivityResult
            }
            val acceptedUris = uris.take(remainingSlots)
            if (acceptedUris.size < uris.size) {
                setLastError(attachmentOverflowMessage)
            }
            acceptedUris.forEach { uri ->
                val attachmentId = appendLoadingAttachment()
                scope.launch {
                    val contentType = context.contentResolver.getType(uri).orEmpty()
                    if (contentType.startsWith("image/")) {
                        val attachment =
                            withContext(Dispatchers.IO) {
                                TurnAttachmentCodec.makeAttachment(context, uri)
                            }
                        updateImageAttachmentResult(attachmentId, attachment)
                        return@launch
                    }
                    val decoded =
                        withContext(Dispatchers.IO) {
                            TurnFileAttachmentCodec.makeAttachment(
                                context = context,
                                uri = uri,
                                maxBytes = maxNonImageAttachmentBytes,
                                maxTextChars = maxNonImageAttachmentTextChars,
                                tooLargeMessage = { fileName, _ ->
                                    "$fileName: $attachmentFileTooLargeMessage"
                                },
                                loadFailedMessage = { fileName ->
                                    "$fileName: $attachmentLoadFailedMessage"
                                },
                            )
                        }
                    updateFileAttachmentResult(
                        attachmentId = attachmentId,
                        attachment = decoded.attachment,
                        errorMessage = decoded.errorMessage,
                    )
                }
            }
        }

    val cameraPreviewLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.TakePicturePreview()) { bitmap ->
            if (bitmap == null) return@rememberLauncherForActivityResult
            if (remainingAttachmentSlots() <= 0) {
                setLastError(attachmentLimitMessage)
                return@rememberLauncherForActivityResult
            }
            val attachmentId = appendLoadingAttachment()
            scope.launch {
                val attachment =
                    withContext(Dispatchers.IO) {
                        TurnAttachmentCodec.makeAttachment(bitmap.toJpegByteArray() ?: return@withContext null)
                    }
                updateImageAttachmentResult(attachmentId, attachment)
            }
        }

    val cameraPermissionLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                cameraPreviewLauncher.launch(null)
            } else {
                setLastError(attachmentCameraPermissionDeniedMessage)
            }
        }

    return TurnAttachmentLaunchActions(
        pickImages = {
            if (!attachmentsAllowed) {
                setLastError(attachmentsBlockedMessage)
                return@TurnAttachmentLaunchActions
            }
            if (attachments.size >= maxAttachments) {
                setLastError(attachmentLimitMessage)
            } else {
                photoPickerLauncher.launch("image/*")
            }
        },
        pickFiles = {
            if (!attachmentsAllowed) {
                setLastError(attachmentsBlockedMessage)
                return@TurnAttachmentLaunchActions
            }
            if (attachments.size >= maxAttachments) {
                setLastError(attachmentLimitMessage)
            } else {
                filePickerLauncher.launch(arrayOf("*/*"))
            }
        },
        takePhoto = {
            if (!attachmentsAllowed) {
                setLastError(attachmentsBlockedMessage)
                return@TurnAttachmentLaunchActions
            }
            if (attachments.size >= maxAttachments) {
                setLastError(attachmentLimitMessage)
                return@TurnAttachmentLaunchActions
            }
            val hasCamera =
                context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
            if (!hasCamera) {
                setLastError(attachmentCameraUnavailableMessage)
                return@TurnAttachmentLaunchActions
            }
            val hasPermission =
                ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                    PackageManager.PERMISSION_GRANTED
            if (hasPermission) {
                cameraPreviewLauncher.launch(null)
            } else {
                cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
            }
        },
    )
}
