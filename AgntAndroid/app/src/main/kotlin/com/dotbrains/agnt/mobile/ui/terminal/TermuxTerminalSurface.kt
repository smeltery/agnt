package com.dotbrains.agnt.mobile.ui.terminal

import android.content.Context
import android.graphics.Typeface
import android.view.KeyEvent
import android.view.MotionEvent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.dotbrains.agnt.mobile.core.terminal.TerminalSize
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TerminalOutput
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import kotlinx.coroutines.flow.Flow

/**
 * Native (non-WebView) terminal renderer using Termux's terminal-view +
 * terminal-emulator (Apache-2.0, jackpal lineage). Ported from upstream
 * Stivy-01/remodex `TermuxTerminalSurface.kt` (245ea8a); the upstream
 * `rememberTerminalViewportBackground` helper is inlined as a constant since
 * we don't carry the upstream `isAgentLightChrome` theme machinery.
 *
 * Used as the WebView-unavailable fallback in `TerminalScreen`. Strictly better
 * than a static text view: parses ANSI escapes, supports scrollback, repaints
 * incrementally as bytes arrive.
 */
private const val TERMINAL_TEXT_SIZE_DP = 10
private val TERMINAL_CONTENT_PADDING = 8.dp
private val TERMINAL_VIEWPORT_BACKGROUND = Color(0xFF000000)

@Composable
fun TermuxTerminalSurface(
    output: Flow<ByteArray>,
    onInput: (ByteArray) -> Unit,
    onResize: (TerminalSize) -> Unit,
    modifier: Modifier = Modifier,
) {
    val focusRequester = remember { FocusRequester() }
    val terminalBridge = remember { TermuxTerminalBridge(onInput = onInput) }
    val density = LocalDensity.current
    val terminalTextSizePx = with(density) { TERMINAL_TEXT_SIZE_DP.dp.toPx().toInt() }
    val inputValue = remember { mutableStateOf("") }
    val lifecycleOwner = LocalLifecycleOwner.current
    val lastSize = remember { mutableStateOf<TerminalSize?>(null) }

    LaunchedEffect(output, terminalBridge) {
        output.collect { bytes -> terminalBridge.feed(bytes) }
    }

    DisposableEffect(lifecycleOwner, terminalBridge) {
        val observer =
            LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_RESUME) {
                    lastSize.value?.let { terminalBridge.resize(it) }
                    terminalBridge.refresh()
                    focusRequester.requestFocus()
                }
            }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    Box(
        modifier =
            modifier
                .background(TERMINAL_VIEWPORT_BACKGROUND)
                .clickable { focusRequester.requestFocus() }
                .onSizeChanged { size ->
                    val horizontalPaddingPx = with(density) { TERMINAL_CONTENT_PADDING.toPx() * 2 }
                    val verticalPaddingPx = with(density) { TERMINAL_CONTENT_PADDING.toPx() * 2 }
                    val contentWidth = (size.width - horizontalPaddingPx).coerceAtLeast(1f)
                    val contentHeight = (size.height - verticalPaddingPx).coerceAtLeast(1f)
                    val fontPx = terminalTextSizePx.toFloat()
                    val cellWidth = (fontPx * 0.62f).coerceAtLeast(1f)
                    val cellHeight = (fontPx * 1.35f).coerceAtLeast(1f)
                    val terminalSize =
                        TerminalSize(
                            cols = (contentWidth / cellWidth).toInt().coerceAtLeast(20),
                            rows = (contentHeight / cellHeight).toInt().coerceAtLeast(5),
                        )
                    lastSize.value = terminalSize
                    onResize(terminalSize)
                    terminalBridge.resize(terminalSize)
                },
    ) {
        AndroidView(
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(TERMINAL_CONTENT_PADDING),
            factory = { context ->
                terminalBridge.createView(context, terminalTextSizePx)
            },
        )
        BasicTextField(
            value = inputValue.value,
            onValueChange = { value ->
                if (value.isNotEmpty()) {
                    onInput(value.terminalInputBytes())
                    inputValue.value = ""
                }
            },
            modifier =
                Modifier
                    .focusRequester(focusRequester)
                    .fillMaxSize()
                    .onPreviewKeyEvent { event ->
                        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                        when (event.key) {
                            Key.Enter -> {
                                onInput(byteArrayOf('\r'.code.toByte()))
                                true
                            }
                            Key.Backspace -> {
                                onInput(byteArrayOf(0x7F.toByte()))
                                true
                            }
                            else -> false
                        }
                    },
            textStyle = TextStyle(color = Color.Transparent),
            cursorBrush = SolidColor(Color.Transparent),
        )
    }
}

private fun String.terminalInputBytes(): ByteArray =
    replace("\r\n", "\r")
        .replace('\n', '\r')
        .encodeToByteArray()

private class TermuxTerminalBridge(
    private val onInput: (ByteArray) -> Unit,
) {
    private var view: TerminalView? = null
    private val output = RemoteTerminalOutput(onInput)
    private val sessionClient = NoopTerminalSessionClient()
    private val viewClient = NoopTerminalViewClient()
    private val emulator =
        TerminalEmulator(
            output,
            80,
            24,
            TerminalEmulator.DEFAULT_TERMINAL_TRANSCRIPT_ROWS,
            sessionClient,
        )

    fun createView(
        context: Context,
        textSizePx: Int,
    ): TerminalView =
        TerminalView(context, null).also { terminalView ->
            terminalView.setTerminalViewClient(viewClient)
            terminalView.setTextSize(textSizePx)
            terminalView.setTypeface(Typeface.MONOSPACE)
            terminalView.mEmulator = emulator
            terminalView.onScreenUpdated()
            view = terminalView
        }

    fun feed(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        emulator.append(bytes, bytes.size)
        view?.onScreenUpdated()
    }

    fun resize(size: TerminalSize) {
        val normalized = size.normalized
        emulator.resize(normalized.cols, normalized.rows)
        view?.onScreenUpdated()
    }

    fun refresh() {
        view?.onScreenUpdated()
        view?.invalidate()
    }
}

private class RemoteTerminalOutput(
    private val onInput: (ByteArray) -> Unit,
) : TerminalOutput() {
    override fun write(
        data: ByteArray,
        offset: Int,
        count: Int,
    ) {
        onInput(data.copyOfRange(offset, offset + count))
    }

    override fun titleChanged(
        oldTitle: String?,
        newTitle: String?,
    ) = Unit

    override fun onCopyTextToClipboard(text: String?) = Unit

    override fun onPasteTextFromClipboard() = Unit

    override fun onBell() = Unit

    override fun onColorsChanged() = Unit
}

private class NoopTerminalSessionClient : TerminalSessionClient {
    override fun onTextChanged(changedSession: TerminalSession?) = Unit
    override fun onTitleChanged(changedSession: TerminalSession?) = Unit
    override fun onSessionFinished(finishedSession: TerminalSession?) = Unit
    override fun onCopyTextToClipboard(
        session: TerminalSession?,
        text: String?,
    ) = Unit

    override fun onPasteTextFromClipboard(session: TerminalSession?) = Unit
    override fun onBell(session: TerminalSession?) = Unit
    override fun onColorsChanged(session: TerminalSession?) = Unit
    override fun onTerminalCursorStateChange(state: Boolean) = Unit
    override fun getTerminalCursorStyle(): Int? = null
    override fun logError(tag: String?, message: String?) = Unit
    override fun logWarn(tag: String?, message: String?) = Unit
    override fun logInfo(tag: String?, message: String?) = Unit
    override fun logDebug(tag: String?, message: String?) = Unit
    override fun logVerbose(tag: String?, message: String?) = Unit
    override fun logStackTraceWithMessage(
        tag: String?,
        message: String?,
        e: Exception?,
    ) = Unit

    override fun logStackTrace(
        tag: String?,
        e: Exception?,
    ) = Unit
}

private class NoopTerminalViewClient : TerminalViewClient {
    override fun onScale(scale: Float): Float = scale.coerceIn(0.8f, 1.4f)
    override fun onSingleTapUp(e: MotionEvent?) = Unit
    override fun shouldBackButtonBeMappedToEscape(): Boolean = false
    override fun shouldEnforceCharBasedInput(): Boolean = true
    override fun shouldUseCtrlSpaceWorkaround(): Boolean = false
    override fun isTerminalViewSelected(): Boolean = false
    override fun copyModeChanged(copyMode: Boolean) = Unit
    override fun onKeyDown(
        keyCode: Int,
        e: KeyEvent?,
        session: TerminalSession?,
    ): Boolean = true

    override fun onKeyUp(
        keyCode: Int,
        e: KeyEvent?,
    ): Boolean = true

    override fun onLongPress(event: MotionEvent?): Boolean = false
    override fun readControlKey(): Boolean = false
    override fun readAltKey(): Boolean = false
    override fun readShiftKey(): Boolean = false
    override fun readFnKey(): Boolean = false
    override fun onCodePoint(
        codePoint: Int,
        ctrlDown: Boolean,
        session: TerminalSession?,
    ): Boolean = true

    override fun onEmulatorSet() = Unit
    override fun logError(tag: String?, message: String?) = Unit
    override fun logWarn(tag: String?, message: String?) = Unit
    override fun logInfo(tag: String?, message: String?) = Unit
    override fun logDebug(tag: String?, message: String?) = Unit
    override fun logVerbose(tag: String?, message: String?) = Unit
    override fun logStackTraceWithMessage(
        tag: String?,
        message: String?,
        e: Exception?,
    ) = Unit

    override fun logStackTrace(
        tag: String?,
        e: Exception?,
    ) = Unit
}
