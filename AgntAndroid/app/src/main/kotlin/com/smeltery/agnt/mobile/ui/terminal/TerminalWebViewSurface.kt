package com.smeltery.agnt.mobile.ui.terminal

import android.annotation.SuppressLint
import android.util.Base64
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.json.JSONObject

/**
 * Compose-wrapped WebView hosting the bundled xterm.js terminal surface
 * (`assets/terminal/terminal.html`). Bidirectional bridge:
 *
 *  * JS → Kotlin: [TerminalJsBridge.onInput], [TerminalJsBridge.onResize], [TerminalJsBridge.onReady]
 *  * Kotlin → JS: `bridge.write(base64)`, `bridge.setBuffer(base64)`, `bridge.clear()`,
 *                  `bridge.setFontSize(size)`, `bridge.setTheme(themeJson)`, `bridge.fit()`
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun TerminalWebViewSurface(
    terminalKey: String,
    initialBuffer: ByteArray,
    fontSize: Double,
    theme: TerminalTheme,
    incomingOutput: Flow<ByteArray>,
    isUnavailableSignal: (String) -> Unit,
    onInput: (ByteArray) -> Unit,
    onResize: (cols: Int, rows: Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val onInputState = rememberUpdatedState(onInput)
    val onResizeState = rememberUpdatedState(onResize)
    val onUnavailable = rememberUpdatedState(isUnavailableSignal)
    var webView by remember { mutableStateOf<WebView?>(null) }
    var isReady by remember { mutableStateOf(false) }

    val bridge =
        remember {
            TerminalJsBridge(
                onInput = { bytes -> onInputState.value(bytes) },
                onResize = { cols, rows -> onResizeState.value(cols, rows) },
                onReady = { isReady = true },
            )
        }

    DisposableEffect(Unit) {
        onDispose {
            webView?.let { view ->
                view.removeJavascriptInterface("AndroidTerminal")
                view.stopLoading()
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
            }
            webView = null
        }
    }

    AndroidView(
        modifier = modifier,
        factory = { context ->
            try {
                val view =
                    WebView(context).apply {
                        setBackgroundColor(android.graphics.Color.parseColor(theme.background))
                        settings.apply {
                            javaScriptEnabled = true
                            allowFileAccess = false
                            allowContentAccess = false
                            domStorageEnabled = true
                            loadWithOverviewMode = true
                            useWideViewPort = true
                            textZoom = 100
                        }
                        addJavascriptInterface(bridge, "AndroidTerminal")
                        webViewClient =
                            object : WebViewClient() {
                                override fun onPageFinished(
                                    view: WebView,
                                    url: String?,
                                ) {
                                    val themeJson =
                                        JSONObject().apply {
                                            put("background", theme.background)
                                            put("foreground", theme.foreground)
                                            put("cursor", theme.cursorForeground)
                                            put("cursorAccent", theme.cursorBackground)
                                            put("selectionBackground", theme.border)
                                            val pal = org.json.JSONArray()
                                            theme.palette.forEach { pal.put(it) }
                                            put("palette", pal)
                                        }
                                    val configJson =
                                        JSONObject().apply {
                                            put("fontSize", fontSize)
                                            put("theme", themeJson)
                                        }
                                    view.evaluateJavascript(
                                        "window.bridge.init(${JSONObject.quote(configJson.toString())});",
                                        null,
                                    )
                                    if (initialBuffer.isNotEmpty()) {
                                        val b64 =
                                            Base64.encodeToString(initialBuffer, Base64.NO_WRAP)
                                        view.evaluateJavascript(
                                            "window.bridge.setBuffer(${JSONObject.quote(b64)});",
                                            null,
                                        )
                                    }
                                }
                            }
                        webChromeClient = WebChromeClient()
                        loadUrl("file:///android_asset/terminal/terminal.html")
                    }
                webView = view
                view
            } catch (error: Throwable) {
                onUnavailable.value(error.message ?: "WebView terminal unavailable.")
                WebView(context)
            }
        },
        update = { view ->
            if (!isReady) return@AndroidView
            view.evaluateJavascript("window.bridge.setFontSize($fontSize);", null)
            val themeJson =
                JSONObject().apply {
                    put("background", theme.background)
                    put("foreground", theme.foreground)
                    put("cursor", theme.cursorForeground)
                    put("cursorAccent", theme.cursorBackground)
                    put("selectionBackground", theme.border)
                    val pal = org.json.JSONArray()
                    theme.palette.forEach { pal.put(it) }
                    put("palette", pal)
                }
            view.evaluateJavascript(
                "window.bridge.setTheme(${JSONObject.quote(themeJson.toString())});",
                null,
            )
            view.setBackgroundColor(android.graphics.Color.parseColor(theme.background))
        },
    )

    // Forward terminal output bytes once the JS surface is ready.
    LaunchedEffect(terminalKey, isReady) {
        if (!isReady) return@LaunchedEffect
        val view = webView ?: return@LaunchedEffect
        if (initialBuffer.isNotEmpty()) {
            val b64 = Base64.encodeToString(initialBuffer, Base64.NO_WRAP)
            view.evaluateJavascript("window.bridge.setBuffer(${JSONObject.quote(b64)});", null)
        }
        incomingOutput.collect { bytes ->
            val target = webView ?: return@collect
            target.writeTerminalBytes(bytes)
        }
    }
}

/**
 * Pushes raw output bytes from the SSH stream into the WebView terminal as base64.
 */
fun WebView.writeTerminalBytes(bytes: ByteArray) {
    if (bytes.isEmpty()) return
    val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
    post { evaluateJavascript("window.bridge.write(${JSONObject.quote(b64)});", null) }
}

private class TerminalJsBridge(
    private val onInput: (ByteArray) -> Unit,
    private val onResize: (Int, Int) -> Unit,
    private val onReady: () -> Unit,
) {
    @Serializable
    private data class ResizeMessage(
        @SerialName("cols") val cols: Int,
        @SerialName("rows") val rows: Int,
    )

    private val json = Json { ignoreUnknownKeys = true }

    @JavascriptInterface
    fun onInput(base64: String) {
        val bytes = runCatching { Base64.decode(base64, Base64.NO_WRAP) }.getOrNull() ?: return
        onInput.invoke(bytes)
    }

    @JavascriptInterface
    fun onResize(jsonString: String) {
        val msg = runCatching { json.decodeFromString(ResizeMessage.serializer(), jsonString) }.getOrNull() ?: return
        onResize.invoke(msg.cols, msg.rows)
    }

    @JavascriptInterface
    fun onReady(
        @Suppress("UNUSED_PARAMETER") payload: String,
    ) {
        onReady.invoke()
    }
}
