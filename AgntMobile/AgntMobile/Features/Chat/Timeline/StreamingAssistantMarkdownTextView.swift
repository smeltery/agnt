// FILE: StreamingAssistantMarkdownTextView.swift
// Purpose: Streams assistant markdown as a settled prefix plus a frontier-faded active block.
// Layer: Turn UI rendering
// Exports: StreamingAssistantMarkdownTextView
// Depends on: Foundation, SwiftUI, MarkdownTextView, StreamingMarkdownBlockSplitter, StreamingMarkdownReveal

import Foundation
import SwiftUI

struct StreamingAssistantMarkdownTextView: View {
    let text: String
    var enablesSelection: Bool = false
    var constrainsToAvailableWidth: Bool = false
    var animatesReveal: Bool = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @ScaledMetric(relativeTo: .body) private var bodyFontSize: CGFloat = 15

    @State private var settledText = ""
    @State private var activeText = ""
    @State private var activeAttributed = AttributedString()
    @State private var activeParsedCount = 0
    @State private var activeRevision = 0
    @State private var fullText = ""
    @State private var reveal = StreamingRevealController()
    @State private var textAdoptionTask: Task<Void, Never>?
    @State private var fadeCache = FrontierFadeCache()
    @State private var seamTopMultiplier: CGFloat = 0
    @State private var seamBottomMultiplier: CGFloat = 0

    var body: some View {
        let resolved = resolvedReveal()
        let layout = VStack(alignment: .leading, spacing: settledText.isEmpty ? 0 : seamSpacing) {
            if !settledText.isEmpty {
                SettledAssistantMarkdownText(
                    text: settledText,
                    enablesSelection: enablesSelection,
                    constrainsToAvailableWidth: constrainsToAvailableWidth,
                    colorScheme: colorScheme
                )
                .equatable()
            }

            if !activeText.isEmpty {
                MarkdownTextView(
                    preparsed: PreparsedMarkdown(value: resolved.attributed, revision: resolved.revision),
                    profile: .assistantProse,
                    enablesSelection: enablesSelection,
                    constrainsToAvailableWidth: constrainsToAvailableWidth
                )
            }
        }

        Group {
            if fullText.isEmpty, !text.isEmpty {
                MarkdownTextView(
                    text: text,
                    profile: .assistantProse,
                    enablesSelection: enablesSelection,
                    constrainsToAvailableWidth: constrainsToAvailableWidth
                )
            } else if constrainsToAvailableWidth {
                layout.frame(maxWidth: .infinity, alignment: .leading)
            } else {
                layout
            }
        }
        .onAppear {
            adoptText(text, animated: false)
        }
        .onChange(of: text) { _, nextText in
            scheduleTextAdoption(nextText, animated: animatesReveal && !reduceMotion)
        }
        .onChange(of: animatesReveal) { _, isAnimating in
            if !isAnimating {
                snapToActive()
            }
        }
        .onChange(of: reduceMotion) { _, reducesMotion in
            if reducesMotion {
                snapToActive()
            }
        }
        .onDisappear {
            textAdoptionTask?.cancel()
            textAdoptionTask = nil
            reveal.stop()
        }
    }

    private var seamSpacing: CGFloat {
        max(seamTopMultiplier, seamBottomMultiplier) * bodyFontSize
    }

    private func resolvedReveal() -> (attributed: AttributedString, revision: String) {
        let bucket = reveal.bucket
        let count = activeParsedCount
        let fullBucket = Int((Double(count) * StreamingMarkdownRevealPolicy.positionQuantization).rounded())
        guard animatesReveal, !reduceMotion, bucket < fullBucket else {
            return (activeAttributed, "full-\(activeRevision)")
        }

        let window = Int(StreamingMarkdownRevealPolicy.fadeWindow(forVelocity: reveal.velocity).rounded())
        let revision = "rev-\(activeRevision)-\(bucket)-\(window)"
        if let cached = fadeCache.value(forRevision: activeRevision, bucket: bucket, window: window) {
            return (cached, revision)
        }

        let position = Double(bucket) / StreamingMarkdownRevealPolicy.positionQuantization
        let faded = Self.applyFrontierFade(to: activeAttributed, position: position, window: Double(window))
        fadeCache.store(faded, revision: activeRevision, bucket: bucket, window: window)
        return (faded, revision)
    }

    private func scheduleTextAdoption(_ nextText: String, animated: Bool) {
        textAdoptionTask?.cancel()
        textAdoptionTask = Task { @MainActor in
            await Task.yield()
            guard !Task.isCancelled else { return }
            adoptText(nextText, animated: animated)
            textAdoptionTask = nil
        }
    }

    private func adoptText(_ nextText: String, animated: Bool) {
        let isAppend = nextText.hasPrefix(fullText)
        let settledDidChange = setFullText(nextText, isAppend: isAppend)

        if nextText.isEmpty {
            reveal.reset(to: 0)
            return
        }

        guard animated, isAppend else {
            snapToActive()
            return
        }

        if settledDidChange {
            reveal.rewindToStart()
        }
        reveal.start(targetCount: activeParsedCount)
    }

    @discardableResult
    private func setFullText(_ nextText: String, isAppend: Bool) -> Bool {
        guard fullText != nextText else { return false }
        fullText = nextText

        if isAppend, !settledText.isEmpty {
            let utf8 = nextText.utf8
            if let tailStart = utf8.index(
                utf8.startIndex,
                offsetBy: settledText.utf8.count + 1,
                limitedBy: utf8.endIndex
            ) {
                let split = StreamingMarkdownBlockSplitter.split(String(nextText[tailStart...]))
                let settledDidChange = !split.settled.isEmpty
                if settledDidChange {
                    settledText += "\n" + split.settled
                    seamBottomMultiplier = StreamingMarkdownBlockSplitter.bottomSpacingMultiplier(
                        forLastBlockOf: split.settled
                    )
                }
                applyActiveBlock(split.active)
                return settledDidChange
            }
        }

        let split = StreamingMarkdownBlockSplitter.split(nextText)
        let settledDidChange = split.settled != settledText
        if settledDidChange {
            settledText = split.settled
            seamBottomMultiplier = StreamingMarkdownBlockSplitter.bottomSpacingMultiplier(
                forLastBlockOf: split.settled
            )
        }
        applyActiveBlock(split.active)
        return settledDidChange
    }

    private func applyActiveBlock(_ active: String) {
        guard active != activeText else { return }
        activeText = active
        activeAttributed = Self.parse(active)
        activeParsedCount = activeAttributed.characters.count
        activeRevision &+= 1
        seamTopMultiplier = StreamingMarkdownBlockSplitter.topSpacingMultiplier(forBlockStarting: active)
        reveal.clampTarget(to: activeParsedCount)
    }

    private func snapToActive() {
        reveal.reset(to: activeParsedCount)
    }

    @MainActor
    private static func parse(_ text: String) -> AttributedString {
        let stableText = StreamingInlineMarkupAutoCloser.autoClosed(text)
        let transformed = MarkdownTextFormatter.renderableText(
            from: stableText,
            profile: .assistantProse,
            usesCache: false
        )
        return (try? UncachedMarkdownParser.shared.attributedString(for: transformed))
            ?? AttributedString(stableText)
    }

    private static func applyFrontierFade(
        to attributed: AttributedString,
        position: Double,
        window: Double
    ) -> AttributedString {
        let total = attributed.characters.count
        let clamped = min(max(position, 0), Double(total))
        guard clamped < Double(total) else { return attributed }

        var copy = attributed
        let hiddenIndex = min(total, Int(clamped.rounded(.up)))
        let hiddenStart = copy.index(copy.startIndex, offsetByCharacters: hiddenIndex)
        copy[hiddenStart..<copy.endIndex].foregroundColor = Color.primary.opacity(0)

        let safeWindow = max(window, 1)
        let windowLength = min(Int(safeWindow.rounded(.up)), hiddenIndex)
        var charStart = copy.index(hiddenStart, offsetByCharacters: -windowLength)

        var index = hiddenIndex - windowLength
        while index < hiddenIndex {
            let charEnd = copy.index(charStart, offsetByCharacters: 1)
            let distance = clamped - Double(index)
            let alpha = min(1.0, max(0.0, distance / safeWindow))
            let existing = copy[charStart..<charEnd].foregroundColor ?? Color.primary
            copy[charStart..<charEnd].foregroundColor = existing.opacity(alpha)
            charStart = charEnd
            index += 1
        }

        return copy
    }
}

private struct SettledAssistantMarkdownText: View, Equatable {
    let text: String
    let enablesSelection: Bool
    let constrainsToAvailableWidth: Bool
    let colorScheme: ColorScheme

    var body: some View {
        MarkdownTextView(
            text: text,
            profile: .assistantProse,
            enablesSelection: enablesSelection,
            constrainsToAvailableWidth: constrainsToAvailableWidth
        )
    }

    static func == (lhs: SettledAssistantMarkdownText, rhs: SettledAssistantMarkdownText) -> Bool {
        lhs.text == rhs.text
            && lhs.enablesSelection == rhs.enablesSelection
            && lhs.constrainsToAvailableWidth == rhs.constrainsToAvailableWidth
            && lhs.colorScheme == rhs.colorScheme
    }
}

private final class FrontierFadeCache {
    private var cachedRevision = -1
    private var cachedBucket = Int.min
    private var cachedWindow = -1
    private var cachedValue = AttributedString()

    func value(forRevision revision: Int, bucket: Int, window: Int) -> AttributedString? {
        guard cachedRevision == revision, cachedBucket == bucket, cachedWindow == window else { return nil }
        return cachedValue
    }

    func store(_ value: AttributedString, revision: Int, bucket: Int, window: Int) {
        cachedRevision = revision
        cachedBucket = bucket
        cachedWindow = window
        cachedValue = value
    }
}
