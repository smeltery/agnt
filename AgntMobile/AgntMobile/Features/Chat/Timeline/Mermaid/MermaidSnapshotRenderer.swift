// FILE: MermaidSnapshotRenderer.swift
// Purpose: WKWebView-backed Mermaid rendering and snapshot capture coordinator.
// Layer: View Support

import SwiftUI
import UIKit
import WebKit

struct MermaidPlaceholderView: View {
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.primary.opacity(0.03))

            Text("Rendering diagram…")
                .font(AppFont.mono(.caption))
                .foregroundStyle(.secondary)
        }
    }
}

struct MermaidSnapshotRenderer: UIViewRepresentable {
    let source: String
    let descriptor: MermaidRenderDescriptor?
    @Binding var renderHeight: CGFloat
    let onResolved: (MermaidRenderedSnapshot) -> Void

    func makeCoordinator() -> MermaidSnapshotRendererCoordinator {
        MermaidSnapshotRendererCoordinator(renderHeight: $renderHeight, onResolved: onResolved)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.add(
            context.coordinator,
            name: MermaidSnapshotRendererCoordinator.heightMessageName
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.isUserInteractionEnabled = false
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.navigationDelegate = context.coordinator
        context.coordinator.attach(webView)
        context.coordinator.loadIfNeeded(
            webView: webView,
            source: MermaidSourceNormalizer.normalized(source),
            descriptor: descriptor
        )
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.attach(webView)
        context.coordinator.loadIfNeeded(
            webView: webView,
            source: MermaidSourceNormalizer.normalized(source),
            descriptor: descriptor
        )
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: MermaidSnapshotRendererCoordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: MermaidSnapshotRendererCoordinator.heightMessageName
        )
        webView.navigationDelegate = nil
    }
}

final class MermaidSnapshotRendererCoordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    static let heightMessageName = "mermaidHeight"

    private let renderHeight: Binding<CGFloat>
    private let onResolved: (MermaidRenderedSnapshot) -> Void
    private weak var webView: WKWebView?
    private var lastSignature: String?
    private var currentDescriptor: MermaidRenderDescriptor?
    private var hasCapturedSnapshot = false
    private var lastResolvedSignature: String?

    init(renderHeight: Binding<CGFloat>, onResolved: @escaping (MermaidRenderedSnapshot) -> Void) {
        self.renderHeight = renderHeight
        self.onResolved = onResolved
    }

    func attach(_ webView: WKWebView) {
        self.webView = webView
    }

    func loadIfNeeded(webView: WKWebView, source: String, descriptor: MermaidRenderDescriptor?) {
        guard let descriptor else {
            return
        }

        let signature = descriptor.cacheKey
        if let cached = MermaidRenderedSnapshotCache.snapshot(for: descriptor) {
            // Defer binding writes so UIViewRepresentable updates never mutate SwiftUI state inline.
            commitRenderHeightIfNeeded(cached.height, signature: signature)
            lastSignature = signature
            currentDescriptor = descriptor
            hasCapturedSnapshot = true
            resolveSnapshot(cached, signature: signature)
            return
        }

        guard lastSignature != signature else {
            return
        }

        lastSignature = signature
        currentDescriptor = descriptor
        hasCapturedSnapshot = false
        lastResolvedSignature = nil
        let fallbackHeight = max(MermaidRenderedSnapshotCache.knownHeight(for: descriptor) ?? 160, 120)
        commitRenderHeightIfNeeded(fallbackHeight, signature: signature)
        webView.frame = CGRect(origin: .zero, size: CGSize(width: descriptor.targetWidth, height: fallbackHeight))

        let html = MermaidHTMLBuilder.html(source: source, isDarkMode: descriptor.isDarkMode)
        if let assetDirectoryURL = MermaidBundledAsset.scriptURL()?.deletingLastPathComponent() {
            webView.loadHTMLString(html, baseURL: assetDirectoryURL)
        } else {
            webView.loadHTMLString(MermaidHTMLBuilder.fallbackHTML(source: source), baseURL: nil)
        }
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == Self.heightMessageName,
              let descriptor = currentDescriptor else {
            return
        }

        let resolvedHeight: CGFloat?
        if let value = message.body as? Double {
            resolvedHeight = CGFloat(value)
        } else if let value = message.body as? Int {
            resolvedHeight = CGFloat(value)
        } else if let value = message.body as? NSNumber {
            resolvedHeight = CGFloat(truncating: value)
        } else {
            resolvedHeight = nil
        }

        guard let resolvedHeight, resolvedHeight.isFinite else {
            return
        }

        let normalizedHeight = max(120, min(resolvedHeight, 1200))
        MermaidRenderedSnapshotCache.storeKnownHeight(normalizedHeight, for: descriptor)
        commitRenderHeightIfNeeded(normalizedHeight, signature: descriptor.cacheKey)

        guard !hasCapturedSnapshot else {
            return
        }
        hasCapturedSnapshot = true

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            self.captureSnapshot(height: normalizedHeight)
        }
    }

    private func captureSnapshot(height: CGFloat) {
        guard let webView,
              let descriptor = currentDescriptor else {
            return
        }

        webView.frame = CGRect(origin: .zero, size: CGSize(width: descriptor.targetWidth, height: height))
        webView.layoutIfNeeded()

        let configuration = WKSnapshotConfiguration()
        configuration.rect = CGRect(origin: .zero, size: CGSize(width: descriptor.targetWidth, height: height))
        configuration.snapshotWidth = NSNumber(value: Double(descriptor.targetWidth))

        webView.takeSnapshot(with: configuration) { image, _ in
            guard let image else {
                self.hasCapturedSnapshot = false
                return
            }

            let snapshot = MermaidRenderedSnapshot(image: image, height: height)
            MermaidRenderedSnapshotCache.store(snapshot, for: descriptor)
            self.resolveSnapshot(snapshot, signature: descriptor.cacheKey)
        }
    }

    // Schedules height changes onto the next main-queue turn so SwiftUI never sees
    // a binding mutation from inside make/updateUIView.
    private func commitRenderHeightIfNeeded(_ height: CGFloat, signature: String) {
        guard abs(renderHeight.wrappedValue - height) > 0.5 else {
            return
        }

        DispatchQueue.main.async {
            guard self.currentDescriptor?.cacheKey == signature else {
                return
            }
            guard abs(self.renderHeight.wrappedValue - height) > 0.5 else {
                return
            }
            self.renderHeight.wrappedValue = height
        }
    }

    // Bounces snapshot resolution out of the current representable update pass.
    private func resolveSnapshot(_ snapshot: MermaidRenderedSnapshot, signature: String) {
        DispatchQueue.main.async {
            guard self.currentDescriptor?.cacheKey == signature else {
                return
            }
            guard self.lastResolvedSignature != signature else {
                return
            }
            self.lastResolvedSignature = signature
            self.onResolved(snapshot)
        }
    }
}

