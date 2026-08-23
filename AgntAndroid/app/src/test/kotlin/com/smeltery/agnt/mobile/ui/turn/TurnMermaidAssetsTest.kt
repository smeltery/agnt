package com.smeltery.agnt.mobile.ui.turn

import org.junit.Test
import java.io.File
import kotlin.test.assertTrue

class TurnMermaidAssetsTest {
    @Test
    fun mermaidHtmlExposesRendererContractUsedByWebViewCard() {
        val html = File("src/main/assets/mermaid/index.html").readText()

        assertTrue(html.contains("window.renderAgntMermaid"))
        assertTrue(html.contains("window.agntMermaidHeight"))
        assertTrue(html.contains("securityLevel: \"strict\""))
        assertTrue(html.contains("./mermaid.min.js"))
    }

    @Test
    fun mermaidJsIsBundledLocally() {
        val asset = File("src/main/assets/mermaid/mermaid.min.js")

        assertTrue(asset.isFile)
        assertTrue(asset.length() > 1_000_000)
    }
}
