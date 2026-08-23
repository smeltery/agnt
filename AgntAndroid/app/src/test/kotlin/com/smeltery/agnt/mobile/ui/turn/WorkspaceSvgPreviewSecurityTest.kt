package com.smeltery.agnt.mobile.ui.turn

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WorkspaceSvgPreviewSecurityTest {
    @Test
    fun sanitizedSource_removesExternalHrefReferences() {
        val source = """<svg><image xlink:href="https://evil.example/x.png"/><use href="#icon"/></svg>"""

        val sanitized = WorkspaceSvgPreviewSecurity.sanitizedSource(source)

        assertFalse(sanitized.contains("https://evil.example"))
        assertTrue(sanitized.contains("""href="#icon""""))
    }

    @Test
    fun sanitizedSource_removesProtocolRelativeAndFileSources() {
        val source = """<svg><image src="//evil.example/x.png"/><use href='file:///tmp/local.svg#icon'/></svg>"""

        val sanitized = WorkspaceSvgPreviewSecurity.sanitizedSource(source)

        assertFalse(sanitized.contains("//evil.example"))
        assertFalse(sanitized.contains("file:///tmp/local.svg"))
    }

    @Test
    fun htmlDocument_includesStrictContentSecurityPolicy() {
        val html = WorkspaceSvgPreviewSecurity.htmlDocument("<svg></svg>", isDark = false)

        assertTrue(html.contains(WorkspaceSvgPreviewSecurity.contentSecurityPolicy))
        assertTrue(html.contains("script-src 'none'"))
        assertTrue(html.contains("connect-src 'none'"))
    }

    @Test
    fun isSvgPath_acceptsQueryAndFragmentSuffixes() {
        assertTrue(WorkspaceSvgPreviewSecurity.isSvgPath("assets/diagram.svg"))
        assertTrue(WorkspaceSvgPreviewSecurity.isSvgPath("assets/diagram.SVG?raw=1#icon"))
        assertFalse(WorkspaceSvgPreviewSecurity.isSvgPath("assets/diagram.svg.txt"))
    }

    @Test
    fun isExternalNavigationUrl_blocksNetworkAndFileSchemes() {
        assertTrue(WorkspaceSvgPreviewSecurity.isExternalNavigationUrl("https://example.com"))
        assertTrue(WorkspaceSvgPreviewSecurity.isExternalNavigationUrl("file:///tmp/x.svg"))
        assertTrue(WorkspaceSvgPreviewSecurity.isExternalNavigationUrl("//example.com/x.svg"))
        assertFalse(WorkspaceSvgPreviewSecurity.isExternalNavigationUrl("about:blank"))
        assertFalse(WorkspaceSvgPreviewSecurity.isExternalNavigationUrl(null))
    }
}
