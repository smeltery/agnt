package com.smeltery.agnt.mobile.ui.turn

import android.graphics.Color
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

internal object WorkspaceSvgPreviewSecurity {
    const val contentSecurityPolicy: String =
        "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; font-src 'none'; base-uri 'none'"

    private val externalReferencePattern =
        Regex(
            pattern = """\s(?:href|xlink:href|src)\s*=\s*(?:(["'])(?:https?:|//|file:)[^"']*\1|(?:https?:|//|file:)[^\s>/]+)""",
            options = setOf(RegexOption.IGNORE_CASE),
        )

    fun sanitizedSource(source: String): String = externalReferencePattern.replace(source, "")

    fun isSvgPath(path: String): Boolean =
        path
            .trim()
            .substringBefore('?')
            .substringBefore('#')
            .endsWith(".svg", ignoreCase = true)

    fun isExternalNavigationUrl(url: String?): Boolean {
        val normalized = url?.trim()?.lowercase().orEmpty()
        return normalized.startsWith("http://") ||
            normalized.startsWith("https://") ||
            normalized.startsWith("file://") ||
            normalized.startsWith("//")
    }

    fun htmlDocument(
        svgSource: String,
        isDark: Boolean,
    ): String {
        val background = if (isDark) "#111114" else "#f7f7f8"
        val foreground = if (isDark) "#f5f5f7" else "#111114"
        val sanitizedSvg = sanitizedSource(svgSource)
        return """
            <!doctype html>
            <html>
            <head>
            <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=8">
            <meta http-equiv="Content-Security-Policy" content="$contentSecurityPolicy">
            <style>
            html, body {
              width: 100%;
              height: 100%;
              margin: 0;
              background: $background;
              color: $foreground;
            }
            body {
              display: grid;
              place-items: center;
              box-sizing: border-box;
              padding: 28px 20px;
            }
            svg {
              max-width: 100%;
              max-height: 100%;
              width: auto;
              height: auto;
            }
            </style>
            </head>
            <body>
            $sanitizedSvg
            </body>
            </html>
            """.trimIndent()
    }
}

@Composable
internal fun WorkspaceSvgPreview(
    source: String,
    isDark: Boolean,
    modifier: Modifier = Modifier,
) {
    val html = WorkspaceSvgPreviewSecurity.htmlDocument(source, isDark)
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                setBackgroundColor(Color.TRANSPARENT)
                settings.javaScriptEnabled = false
                settings.domStorageEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.blockNetworkLoads = true
                webViewClient =
                    object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(
                            view: WebView,
                            request: WebResourceRequest,
                        ): Boolean = WorkspaceSvgPreviewSecurity.isExternalNavigationUrl(request.url?.toString()) || request.url?.toString() != "about:blank"
                    }
            }
        },
        update = { webView ->
            webView.loadDataWithBaseURL("about:blank", html, "text/html", "UTF-8", null)
        },
    )
}
