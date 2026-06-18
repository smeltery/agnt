// FILE: WorkspaceSVGPreview.swift
// Purpose: Renders workspace SVG artifacts as artwork inside a hardened, offline WKWebView.
// Layer: Timeline preview (WebKit host + security helper)
// Exports: WorkspaceSVGPreviewSecurity, WorkspaceSVGWebView
// Depends on: Foundation, SwiftUI, WebKit

import Foundation
import SwiftUI
import WebKit

/// Centralizes SVG preview hardening so WebKit renders local vector artwork without
/// reaching the network. Agents can emit arbitrary SVG, so the markup is treated as
/// untrusted: a strict CSP blocks scripts/fetches and external references are stripped
/// before WebKit ever sees them.
enum WorkspaceSVGPreviewSecurity {
    static let contentSecurityPolicy = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; font-src 'none'; base-uri 'none'"

    /// Removes obvious external references (`href`/`xlink:href`/`src` pointing at
    /// http(s)/protocol-relative/file URLs) before WebKit parses the SVG markup.
    static func sanitizedSVGSource(_ source: String) -> String {
        let pattern = #"\s(?:href|xlink:href|src)\s*=\s*(?:(["'])(?:https?:|//|file:)[^"']*\1|(?:https?:|//|file:)[^\s>/]+)"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return source
        }
        let range = NSRange(source.startIndex..., in: source)
        return regex.stringByReplacingMatches(in: source, options: [], range: range, withTemplate: "")
    }

    static func isExternalNavigationURL(_ url: URL?) -> Bool {
        guard let scheme = url?.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https" || scheme == "file"
    }
}

/// Hosts raw SVG markup in an isolated page so vector files preview as artwork, not source text.
struct WorkspaceSVGWebView: UIViewRepresentable {
    let source: String
    let colorScheme: ColorScheme

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.minimumZoomScale = 1
        webView.scrollView.maximumZoomScale = 8
        webView.scrollView.bouncesZoom = true
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        let html = Self.htmlDocument(svgSource: source, isDark: colorScheme == .dark)
        guard context.coordinator.loadedHTML != html else { return }
        context.coordinator.loadedHTML = html
        context.coordinator.prepareForHTMLLoad()
        webView.loadHTMLString(html, baseURL: nil)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedHTML: String?
        private var didAllowInitialNavigation = false

        func prepareForHTMLLoad() {
            didAllowInitialNavigation = false
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if WorkspaceSVGPreviewSecurity.isExternalNavigationURL(navigationAction.request.url) {
                decisionHandler(.cancel)
                return
            }

            // Only the initial in-memory document load is allowed; everything else
            // (link taps, redirects) is rejected so the preview cannot navigate away.
            guard !didAllowInitialNavigation, navigationAction.navigationType == .other else {
                decisionHandler(.cancel)
                return
            }

            didAllowInitialNavigation = true
            decisionHandler(.allow)
        }
    }

    static func htmlDocument(svgSource: String, isDark: Bool) -> String {
        let background = isDark ? "#111114" : "#f7f7f8"
        let foreground = isDark ? "#f5f5f7" : "#111114"
        let sanitizedSVG = WorkspaceSVGPreviewSecurity.sanitizedSVGSource(svgSource)
        return """
        <!doctype html>
        <html>
        <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=8">
        <meta http-equiv="Content-Security-Policy" content="\(WorkspaceSVGPreviewSecurity.contentSecurityPolicy)">
        <style>
        html, body {
          width: 100%;
          height: 100%;
          margin: 0;
          background: \(background);
          color: \(foreground);
        }
        body {
          display: grid;
          place-items: center;
          box-sizing: border-box;
          padding: 88px 20px 28px;
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
        \(sanitizedSVG)
        </body>
        </html>
        """
    }
}
