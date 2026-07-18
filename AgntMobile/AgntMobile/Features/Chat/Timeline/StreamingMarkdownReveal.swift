// FILE: StreamingMarkdownReveal.swift
// Purpose: Vsync-locked reveal engine for streaming assistant markdown.
// Layer: Turn UI rendering support
// Exports: StreamingMarkdownRevealPolicy, StreamingRevealController
// Depends on: Foundation, Observation, QuartzCore

import Foundation
import Observation
import QuartzCore

enum StreamingMarkdownRevealPolicy {
    static let drainWindowSeconds = 0.16
    static let maximumCharactersPerSecond = 2_000.0
    static let velocityLerp = 0.15
    static let maximumFrameSeconds: TimeInterval = 0.05
    static let positionQuantization = 4.0
    static let fadeDurationSeconds = 0.32
    static let minimumFadeWindowCharacters = 10.0
    static let maximumFadeWindowCharacters = 30.0
    static let maxHiddenTailCharacters = 24

    static func fadeWindow(forVelocity velocity: Double) -> Double {
        let raw = velocity * fadeDurationSeconds
        return min(maximumFadeWindowCharacters, max(minimumFadeWindowCharacters, raw))
    }
}

@MainActor
@Observable
final class StreamingRevealController {
    private(set) var bucket = 0

    @ObservationIgnored private(set) var revealedPosition: Double = 0
    @ObservationIgnored private(set) var velocity: Double = 0
    @ObservationIgnored private var targetCount = 0
    @ObservationIgnored private var displayLink: CADisplayLink?
    @ObservationIgnored private var lastTimestamp: CFTimeInterval?
    @ObservationIgnored private let proxy = DisplayLinkProxy()

    init() {
        proxy.onFrame = { [weak self] link in
            guard let self else {
                link.invalidate()
                return
            }
            self.handleFrame(link)
        }
    }

    func reset(to count: Int) {
        stop()
        targetCount = count
        velocity = 0
        revealedPosition = Double(count)
        publishBucket()
    }

    func rewindToStart() {
        revealedPosition = 0
        velocity = 0
        publishBucket()
    }

    func clampTarget(to count: Int) {
        targetCount = count
        if revealedPosition > Double(count) {
            revealedPosition = Double(count)
            publishBucket()
        }
    }

    func start(targetCount count: Int) {
        targetCount = count
        guard revealedPosition < Double(count) else {
            reset(to: count)
            return
        }
        guard displayLink == nil else { return }
        lastTimestamp = nil
        let link = CADisplayLink(target: proxy, selector: #selector(DisplayLinkProxy.step(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 80)
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    func stop() {
        displayLink?.invalidate()
        displayLink = nil
        lastTimestamp = nil
    }

    private func handleFrame(_ link: CADisplayLink) {
        let count = Double(targetCount)
        if revealedPosition >= count {
            revealedPosition = count
            publishBucket()
            stop()
            return
        }

        let now = link.timestamp
        let delta = lastTimestamp.map {
            min(now - $0, StreamingMarkdownRevealPolicy.maximumFrameSeconds)
        } ?? 0
        lastTimestamp = now

        let backlog = count - revealedPosition
        let targetVelocity = min(
            StreamingMarkdownRevealPolicy.maximumCharactersPerSecond,
            backlog / StreamingMarkdownRevealPolicy.drainWindowSeconds
        )
        velocity += (targetVelocity - velocity) * StreamingMarkdownRevealPolicy.velocityLerp

        var next = min(count, revealedPosition + velocity * delta)
        let minReveal = max(0, count - Double(StreamingMarkdownRevealPolicy.maxHiddenTailCharacters))
        if next < minReveal { next = minReveal }
        revealedPosition = next

        if next >= count {
            revealedPosition = count
            stop()
        }
        publishBucket()
    }

    private func publishBucket() {
        let next = Int((revealedPosition * StreamingMarkdownRevealPolicy.positionQuantization).rounded())
        if next != bucket {
            bucket = next
        }
    }
}

private final class DisplayLinkProxy: NSObject {
    var onFrame: (@MainActor (CADisplayLink) -> Void)?

    @objc func step(_ link: CADisplayLink) {
        MainActor.assumeIsolated { onFrame?(link) }
    }
}
