package com.smeltery.agnt.mobile.ui.turn

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.smeltery.agnt.mobile.core.error.AgentServiceError
import com.smeltery.agnt.mobile.core.model.ActiveProvider
import com.smeltery.agnt.mobile.core.transport.ConnectionState
import com.smeltery.agnt.mobile.core.voice.BridgeVoiceRecorder
import com.smeltery.agnt.mobile.core.voice.VoiceDraftAppend
import com.smeltery.agnt.mobile.data.CodexRepository
import com.smeltery.agnt.mobile.ui.turn.composer.TurnVoicePhase
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal data class TurnVoiceControls(
    val phase: TurnVoicePhase,
    val audioLevels: List<Float>,
    val recordingDurationSeconds: Double,
    val isTranscribing: Boolean,
    val isInteractionEnabled: Boolean,
    val onVoiceClick: () -> Unit,
    val onCancelRecording: () -> Unit,
    val cancelActiveWork: () -> Unit,
)

@Composable
internal fun rememberTurnVoiceControls(
    threadId: String,
    repository: CodexRepository,
    ready: Boolean,
    connectionState: ConnectionState,
    sending: Boolean,
    bridgeSupportsVoiceTranscription: Boolean,
    activeProvider: ActiveProvider,
    draft: String,
    setDraft: (String) -> Unit,
    setLastError: (String?) -> Unit,
    micDeniedMessage: String,
    recorderFailedMessage: String,
    noAudioMessage: String,
    transcriptionFailedMessage: String,
): TurnVoiceControls {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val voiceRecorder = remember(threadId) { BridgeVoiceRecorder() }
    var voicePhase by remember(threadId) { mutableStateOf(TurnVoicePhase.Idle) }
    var voiceAudioLevels by remember(threadId) { mutableStateOf<List<Float>>(emptyList()) }
    var voiceRecordingDurationSeconds by remember(threadId) { mutableStateOf(0.0) }
    var transcribeJob by remember(threadId) { mutableStateOf<Job?>(null) }

    fun appendVoiceAudioLevel(level: Float) {
        scope.launch {
            if (voicePhase != TurnVoicePhase.Recording) return@launch
            voiceAudioLevels = (voiceAudioLevels + level.coerceIn(0f, 1f)).takeLast(240)
        }
    }

    fun resetVoiceMeteringState() {
        voiceAudioLevels = emptyList()
        voiceRecordingDurationSeconds = 0.0
    }

    fun cancelActiveWork() {
        transcribeJob?.cancel()
        transcribeJob = null
        voiceRecorder.cancel()
        voicePhase = TurnVoicePhase.Idle
        resetVoiceMeteringState()
    }

    fun startRecording() {
        scope.launch {
            if (voicePhase != TurnVoicePhase.Idle) return@launch
            resetVoiceMeteringState()
            val ok =
                withContext(Dispatchers.IO) {
                    voiceRecorder.start(::appendVoiceAudioLevel)
                }
            if (ok) {
                voicePhase = TurnVoicePhase.Recording
            } else {
                resetVoiceMeteringState()
                setLastError(recorderFailedMessage)
            }
        }
    }

    val audioPermissionLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                startRecording()
            } else {
                setLastError(micDeniedMessage)
            }
        }

    val voiceInteractionEnabled =
        remember(ready, connectionState, sending, bridgeSupportsVoiceTranscription, activeProvider) {
            if (!ready || connectionState !is ConnectionState.Connected || sending) {
                false
            } else {
                when (activeProvider) {
                    ActiveProvider.Codex -> bridgeSupportsVoiceTranscription
                    ActiveProvider.Claude,
                    ActiveProvider.Opencode,
                    ActiveProvider.Cursor,
                    -> false
                    ActiveProvider.Unknown -> bridgeSupportsVoiceTranscription
                }
            }
        }

    LaunchedEffect(threadId) {
        cancelActiveWork()
    }

    LaunchedEffect(threadId, voicePhase) {
        if (voicePhase != TurnVoicePhase.Recording) return@LaunchedEffect
        val startedAtNanos = System.nanoTime()
        while (isActive && voicePhase == TurnVoicePhase.Recording) {
            voiceRecordingDurationSeconds = (System.nanoTime() - startedAtNanos) / 1_000_000_000.0
            delay(100)
        }
    }

    return TurnVoiceControls(
        phase = voicePhase,
        audioLevels = voiceAudioLevels,
        recordingDurationSeconds = voiceRecordingDurationSeconds,
        isTranscribing = voicePhase == TurnVoicePhase.Transcribing || transcribeJob != null,
        isInteractionEnabled = voiceInteractionEnabled,
        onVoiceClick = {
            when (voicePhase) {
                TurnVoicePhase.Idle -> {
                    if (voiceInteractionEnabled) {
                        val hasAudioPermission =
                            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                                PackageManager.PERMISSION_GRANTED
                        if (!hasAudioPermission) {
                            audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                        } else {
                            startRecording()
                        }
                    }
                }
                TurnVoicePhase.Recording -> {
                    scope.launch {
                        if (voicePhase != TurnVoicePhase.Recording) return@launch
                        val encoded =
                            withContext(Dispatchers.IO) {
                                voiceRecorder.stopAndEncodeWav()
                            }
                        val pair =
                            encoded.getOrElse { err ->
                                voicePhase = TurnVoicePhase.Idle
                                resetVoiceMeteringState()
                                if (err.message != "not_recording") {
                                    setLastError(
                                        when (err.message) {
                                            "empty_audio" -> noAudioMessage
                                            else -> recorderFailedMessage
                                        },
                                    )
                                }
                                return@launch
                            }
                        voicePhase = TurnVoicePhase.Transcribing
                        resetVoiceMeteringState()
                        transcribeJob =
                            scope.launch {
                                try {
                                    val text =
                                        repository.transcribeBridgeVoiceWav(
                                            pair.first,
                                            pair.second,
                                        )
                                    if (isActive) {
                                        setDraft(VoiceDraftAppend.append(draft, text))
                                    }
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (e: Exception) {
                                    if (isActive) {
                                        setLastError(
                                            when (e) {
                                                is AgentServiceError -> e.message ?: transcriptionFailedMessage
                                                else -> e.message ?: transcriptionFailedMessage
                                            },
                                        )
                                    }
                                } finally {
                                    transcribeJob = null
                                    if (isActive) {
                                        voicePhase = TurnVoicePhase.Idle
                                    }
                                }
                            }
                    }
                }
                TurnVoicePhase.Transcribing -> Unit
            }
        },
        onCancelRecording = {
            scope.launch {
                if (voicePhase != TurnVoicePhase.Recording) return@launch
                withContext(Dispatchers.IO) { voiceRecorder.cancel() }
                voicePhase = TurnVoicePhase.Idle
                resetVoiceMeteringState()
            }
        },
        cancelActiveWork = ::cancelActiveWork,
    )
}
