// FILE: WorkspaceSVGPreviewSecurityTests.swift
// Purpose: Pins the SVG preview hardening that keeps untrusted agent-generated markup offline.
// Layer: Unit Test
// Exports: WorkspaceSVGPreviewSecurityTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

final class WorkspaceSVGPreviewSecurityTests: XCTestCase {
    func testStripsExternalHTTPHref() {
        let source = #"<svg><image xlink:href="https://evil.example/x.png"/></svg>"#

        let sanitized = WorkspaceSVGPreviewSecurity.sanitizedSVGSource(source)

        XCTAssertFalse(sanitized.contains("https://evil.example"))
    }

    func testStripsProtocolRelativeSrc() {
        let source = #"<svg><image src="//evil.example/x.png"/></svg>"#

        let sanitized = WorkspaceSVGPreviewSecurity.sanitizedSVGSource(source)

        XCTAssertFalse(sanitized.contains("//evil.example"))
    }

    func testStripsFileHref() {
        let source = #"<svg><a href="file:///etc/passwd">x</a></svg>"#

        let sanitized = WorkspaceSVGPreviewSecurity.sanitizedSVGSource(source)

        XCTAssertFalse(sanitized.contains("file://"))
    }

    func testKeepsLocalFragmentReferences() {
        // In-document references (e.g. gradients) must survive sanitization.
        let source = #"<svg><rect fill="url(#grad)"/><use href="#icon"/></svg>"#

        let sanitized = WorkspaceSVGPreviewSecurity.sanitizedSVGSource(source)

        XCTAssertTrue(sanitized.contains("#icon"))
        XCTAssertTrue(sanitized.contains("url(#grad)"))
    }

    func testContentSecurityPolicyBlocksScriptsAndConnections() {
        let policy = WorkspaceSVGPreviewSecurity.contentSecurityPolicy

        XCTAssertTrue(policy.contains("default-src 'none'"))
        XCTAssertTrue(policy.contains("script-src 'none'"))
        XCTAssertTrue(policy.contains("connect-src 'none'"))
    }

    func testIdentifiesExternalNavigationSchemes() {
        XCTAssertTrue(WorkspaceSVGPreviewSecurity.isExternalNavigationURL(URL(string: "https://example.com")))
        XCTAssertTrue(WorkspaceSVGPreviewSecurity.isExternalNavigationURL(URL(string: "file:///tmp/x")))
        XCTAssertFalse(WorkspaceSVGPreviewSecurity.isExternalNavigationURL(URL(string: "about:blank")))
        XCTAssertFalse(WorkspaceSVGPreviewSecurity.isExternalNavigationURL(nil))
    }
}
