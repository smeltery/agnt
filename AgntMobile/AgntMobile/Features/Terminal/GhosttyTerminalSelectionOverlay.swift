// FILE: GhosttyTerminalSelectionOverlay.swift
// Purpose: Draws and manages terminal text-selection highlights and handles.
// Layer: View Infrastructure
// Exports: TerminalSelectionOverlayView and selection geometry models
// Depends on: UIKit

import UIKit

struct TerminalSelectionCell: Equatable {
    let column: Int
    let row: Int
}

struct TerminalSelectionRange {
    let anchor: TerminalSelectionCell
    let focus: TerminalSelectionCell

    var normalized: (start: TerminalSelectionCell, end: TerminalSelectionCell) {
        if anchor.row < focus.row || (anchor.row == focus.row && anchor.column <= focus.column) {
            return (anchor, focus)
        }
        return (focus, anchor)
    }
}

struct TerminalSelectionMetrics: Equatable {
    let columns: Int
    let rows: Int
    let cellSize: CGSize
}

struct TerminalRowCharacter {
    let character: Character
    let startColumn: Int
    let endColumn: Int
}

struct TerminalVisualRow {
    let text: String
    let hasHardLineBreakAfter: Bool
}

enum TerminalSelectionHandle {
    case start
    case end
}

final class TerminalSelectionOverlayView: UIView {
    private static let handleRadius: CGFloat = 7
    private static let handleHitRadius: CGFloat = 30

    private let handlePanGesture = UIPanGestureRecognizer()
    private var activeHandle: TerminalSelectionHandle?

    var onHandleDrag: ((TerminalSelectionHandle, CGPoint, UIGestureRecognizer.State) -> Void)?

    var metrics: TerminalSelectionMetrics? {
        didSet {
            guard oldValue != metrics else { return }
            setNeedsDisplay()
        }
    }

    var selectionRange: TerminalSelectionRange? {
        didSet {
            setNeedsDisplay()
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        configureHandleGestures()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configureHandleGestures()
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        handle(at: point) != nil
    }

    override func draw(_ rect: CGRect) {
        guard let metrics, let selectionRange else { return }

        UIColor.systemBlue.withAlphaComponent(0.24).setFill()
        for selectionRect in selectionRects(for: selectionRange, metrics: metrics) {
            UIBezierPath(roundedRect: selectionRect, cornerRadius: 2).fill()
        }

        drawHandles(for: selectionRange, metrics: metrics)
    }

    func menuTargetRect() -> CGRect? {
        guard let metrics, let selectionRange else { return nil }
        let rects = selectionRects(for: selectionRange, metrics: metrics)
        guard var unionRect = rects.first else { return nil }
        for rect in rects.dropFirst() {
            unionRect = unionRect.union(rect)
        }
        return unionRect.insetBy(dx: 0, dy: -6)
    }

    private func configureHandleGestures() {
        isMultipleTouchEnabled = false
        handlePanGesture.addTarget(self, action: #selector(handleHandlePan(_:)))
        addGestureRecognizer(handlePanGesture)
    }

    @objc private func handleHandlePan(_ gesture: UIPanGestureRecognizer) {
        let location = gesture.location(in: self)
        switch gesture.state {
        case .began:
            activeHandle = handle(at: location)
            if let activeHandle {
                onHandleDrag?(activeHandle, location, gesture.state)
            }
        case .changed, .ended, .cancelled, .failed:
            guard let activeHandle else { return }
            onHandleDrag?(activeHandle, location, gesture.state)
            if gesture.state == .ended || gesture.state == .cancelled || gesture.state == .failed {
                self.activeHandle = nil
            }
        default:
            break
        }
    }

    private func selectionRects(
        for selectionRange: TerminalSelectionRange,
        metrics: TerminalSelectionMetrics
    ) -> [CGRect] {
        let normalizedRange = selectionRange.normalized
        let start = normalizedRange.start
        let end = normalizedRange.end
        guard start.row <= end.row else { return [] }

        let rowRange = start.row...end.row
        return rowRange.compactMap { row in
            let firstColumn = row == start.row ? start.column : 0
            let lastColumn = row == end.row ? end.column : metrics.columns - 1
            guard lastColumn >= firstColumn else { return nil }

            return CGRect(
                x: CGFloat(firstColumn) * metrics.cellSize.width,
                y: CGFloat(row) * metrics.cellSize.height,
                width: CGFloat(lastColumn - firstColumn + 1) * metrics.cellSize.width,
                height: metrics.cellSize.height
            ).insetBy(dx: 0, dy: max(1, metrics.cellSize.height * 0.08))
        }
    }

    private func handle(at point: CGPoint) -> TerminalSelectionHandle? {
        guard let metrics, let selectionRange else { return nil }
        let centers = handleCenters(for: selectionRange, metrics: metrics)
        let startDistance = hypot(point.x - centers.start.x, point.y - centers.start.y)
        let endDistance = hypot(point.x - centers.end.x, point.y - centers.end.y)
        let hitRadius = Self.handleHitRadius

        switch (startDistance <= hitRadius, endDistance <= hitRadius) {
        case (true, true):
            return startDistance <= endDistance ? .start : .end
        case (true, false):
            return .start
        case (false, true):
            return .end
        case (false, false):
            return nil
        }
    }

    private func handleCenters(
        for selectionRange: TerminalSelectionRange,
        metrics: TerminalSelectionMetrics
    ) -> (start: CGPoint, end: CGPoint) {
        let normalizedRange = selectionRange.normalized
        let start = normalizedRange.start
        let end = normalizedRange.end
        let rawCenters = (
            CGPoint(
                x: CGFloat(start.column) * metrics.cellSize.width,
                y: CGFloat(start.row + 1) * metrics.cellSize.height
            ),
            CGPoint(
                x: CGFloat(end.column + 1) * metrics.cellSize.width,
                y: CGFloat(end.row + 1) * metrics.cellSize.height
            )
        )
        return (
            clampHandleCenter(rawCenters.0),
            clampHandleCenter(rawCenters.1)
        )
    }

    private func clampHandleCenter(_ point: CGPoint) -> CGPoint {
        let radius = Self.handleRadius
        guard bounds.width > radius * 2, bounds.height > radius * 2 else { return point }
        return CGPoint(
            x: min(max(point.x, radius), bounds.width - radius),
            y: min(max(point.y, radius), bounds.height - radius)
        )
    }

    private func drawHandles(
        for selectionRange: TerminalSelectionRange,
        metrics: TerminalSelectionMetrics
    ) {
        let radius = Self.handleRadius
        let centers = handleCenters(for: selectionRange, metrics: metrics)

        UIColor.black.withAlphaComponent(0.92).setFill()
        UIBezierPath(
            ovalIn: CGRect(x: centers.start.x - radius, y: centers.start.y - radius, width: radius * 2, height: radius * 2)
        ).fill()
        UIBezierPath(
            ovalIn: CGRect(x: centers.end.x - radius, y: centers.end.y - radius, width: radius * 2, height: radius * 2)
        ).fill()
    }
}
