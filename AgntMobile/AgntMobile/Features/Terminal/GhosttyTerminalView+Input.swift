// FILE: GhosttyTerminalView+Input.swift
// Purpose: Keyboard, gesture, and edit-menu input handling for GhosttyTerminalView.
// Layer: View Infrastructure

import GhosttyKit
import UIKit

extension GhosttyTerminalView {
    @objc func handleViewportTap() {
        if hasAppSelection {
            clearAppSelection()
            return
        }
        requestKeyboardFocus()
    }

    // Scroll stays gesture-driven; text selection gets its own long-press path below.
    @objc func handleViewportPan(_ gesture: UIPanGestureRecognizer) {
        guard let surface else { return }
        guard !isSelectingText else {
            pendingVerticalScrollPoints = 0
            gesture.setTranslation(.zero, in: terminalViewport)
            return
        }

        let location = gesture.location(in: terminalViewport)
        sendGhosttyMousePosition(location)

        switch gesture.state {
        case .began:
            if hasAppSelection {
                clearAppSelection()
            }
            pendingVerticalScrollPoints = 0
            gesture.setTranslation(.zero, in: terminalViewport)
        case .changed:
            let translation = gesture.translation(in: terminalViewport)
            let stepSize = max(fontSize * Self.verticalScrollStepMultiplier, Self.minimumVerticalScrollStepPoints)
            let totalVerticalPoints = pendingVerticalScrollPoints + translation.y
            let verticalSteps = Int(totalVerticalPoints / stepSize)
            pendingVerticalScrollPoints = totalVerticalPoints - (CGFloat(verticalSteps) * stepSize)

            guard verticalSteps != 0 else {
                gesture.setTranslation(.zero, in: terminalViewport)
                return
            }

            ghostty_surface_mouse_scroll(surface, 0, Double(verticalSteps), 0)
            redrawSurface()
            gesture.setTranslation(.zero, in: terminalViewport)
        default:
            pendingVerticalScrollPoints = 0
            gesture.setTranslation(.zero, in: terminalViewport)
        }
    }

    // Long-press selection is iOS-owned: UIKit handles the touch UX while
    // Ghostty remains the source of truth for the text in selected cells.
    @objc func handleTextSelectionLongPress(_ gesture: UILongPressGestureRecognizer) {
        let location = gesture.location(in: terminalViewport)
        switch gesture.state {
        case .began:
            clearAppSelection()
            guard let cell = terminalCell(at: location),
                  let initialRange = wordSelectionRange(at: cell) else { return }
            selectionGestureStartPoint = location
            selectionGestureDidDrag = false
            selectedTextForEditMenu = ""
            selectionAnchorCell = initialRange.anchor
            selectionFocusCell = initialRange.focus
            selectionMenuTargetRect = nil
            isSelectingText = true
            updateSelectionOverlay()
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
        case .changed:
            guard isSelectingText else { return }
            guard shouldExtendSelectionDrag(to: location) else { return }
            updateSelectionFocus(at: location)
        case .ended:
            guard isSelectingText else { return }
            if selectionGestureDidDrag {
                updateSelectionFocus(at: location)
            }
            isSelectingText = false
            selectionGestureStartPoint = nil
            selectionGestureDidDrag = false
            presentCopyMenuIfSelectionExists()
        case .cancelled, .failed:
            clearAppSelection()
        default:
            break
        }
    }

    @objc func handleInputEditingDidBegin() {
        textInputModeDidChange()
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        false
    }

    func editMenuInteraction(
        _ interaction: UIEditMenuInteraction,
        menuFor configuration: UIEditMenuConfiguration,
        suggestedActions: [UIMenuElement]
    ) -> UIMenu? {
        guard !selectedTextForEditMenu.isEmpty else { return nil }
        let copyAction = UIAction(title: "Copy", image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in
            self?.copyCurrentSelectionToPasteboard()
        }
        return UIMenu(children: [copyAction])
    }

    func editMenuInteraction(
        _ interaction: UIEditMenuInteraction,
        targetRectFor configuration: UIEditMenuConfiguration
    ) -> CGRect {
        selectionMenuTargetRect ?? CGRect(
            x: configuration.sourcePoint.x - 1,
            y: configuration.sourcePoint.y - max(fontSize * 1.4, 18),
            width: 2,
            height: max(fontSize * 1.4, 18)
        )
    }

    func requestKeyboardFocus() {
        guard window != nil else { return }
        inputField.becomeFirstResponder()
        textInputModeDidChange()
    }

    func emitInput(_ data: Data) {
        guard !data.isEmpty else { return }
        if hasAppSelection {
            clearAppSelection()
        }
        onInput?(data)
    }

    func textInputModeDidChange() {
        guard let app else { return }
        ghostty_app_keyboard_changed(app)
    }

    // Terminal apps expect Return as carriage return; raw-mode pickers often ignore LF.
    static func terminalInputData(for text: String) -> Data {
        text == "\n" || text == "\r" ? terminalReturnSequence : Data(text.utf8)
    }

    var hasAppSelection: Bool {
        selectionAnchorCell != nil && selectionFocusCell != nil
    }

    func sendGhosttyMousePosition(_ location: CGPoint) {
        guard let surface else { return }
        ghostty_surface_mouse_pos(
            surface,
            Double(location.x * contentScaleFactor),
            Double(location.y * contentScaleFactor),
            GHOSTTY_MODS_NONE
        )
    }

    // Reads Ghostty text only when the gesture ends, while UIKit owns the
    // mobile selection handles/highlight above the renderer.
    func presentCopyMenuIfSelectionExists() {
        guard let selectedText = readTextForCurrentSelection(),
              !selectedText.isEmpty else {
            clearAppSelection()
            return
        }

        selectedTextForEditMenu = selectedText
        selectionMenuTargetRect = selectionOverlay.menuTargetRect() ?? terminalViewport.bounds
        let sourcePoint = CGPoint(x: selectionMenuTargetRect?.midX ?? 0, y: selectionMenuTargetRect?.minY ?? 0)
        let configuration = UIEditMenuConfiguration(identifier: nil, sourcePoint: sourcePoint)
        selectionEditMenuInteraction.presentEditMenu(with: configuration)
    }

    // Copy uses the captured menu text so live terminal output cannot change
    // what the user selected while the menu is open.
    func copyCurrentSelectionToPasteboard() {
        let latestSelection = selectedTextForEditMenu.isEmpty
            ? readTextForCurrentSelection() ?? ""
            : selectedTextForEditMenu
        guard !latestSelection.isEmpty else { return }
        UIPasteboard.general.string = latestSelection
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
    }

    func shouldExtendSelectionDrag(to location: CGPoint) -> Bool {
        guard !selectionGestureDidDrag else { return true }
        guard let selectionGestureStartPoint else { return false }

        let distance = hypot(location.x - selectionGestureStartPoint.x, location.y - selectionGestureStartPoint.y)
        guard distance >= Self.selectionDragActivationDistance else { return false }

        selectionGestureDidDrag = true
        return true
    }

    func updateSelectionFocus(at location: CGPoint) {
        guard let cell = terminalCell(at: location), cell != selectionFocusCell else { return }
        selectionFocusCell = cell
        selectedTextForEditMenu = ""
        updateSelectionOverlay()
    }

    func handleSelectionHandleDrag(
        _ handle: TerminalSelectionHandle,
        location: CGPoint,
        state: UIGestureRecognizer.State
    ) {
        guard let currentRange = selectionRange?.normalized else { return }

        if state == .began {
            guard let metrics = currentSelectionMetrics() else { return }
            let startCell = handle == .start ? currentRange.start : currentRange.end
            let startLocation = handleBoundaryPoint(for: startCell, handle: handle, metrics: metrics)
            selectionEditMenuInteraction.dismissMenu()
            handleDragOppositeCell = handle == .start ? currentRange.end : currentRange.start
            handleDragStartCell = startCell
            handleDragStartLocation = startLocation
            handleDragTouchOffset = CGPoint(x: location.x - startLocation.x, y: location.y - startLocation.y)
            return
        }

        if state == .cancelled || state == .failed {
            handleDragOppositeCell = nil
            handleDragStartCell = nil
            handleDragStartLocation = nil
            handleDragTouchOffset = nil
            return
        }

        guard let cell = terminalCellForHandleDrag(at: location) else { return }
        let oppositeCell = handleDragOppositeCell ?? (handle == .start ? currentRange.end : currentRange.start)

        switch handle {
        case .start:
            selectionAnchorCell = cell
            selectionFocusCell = oppositeCell
        case .end:
            selectionAnchorCell = oppositeCell
            selectionFocusCell = cell
        }

        selectedTextForEditMenu = ""
        updateSelectionOverlay()

        if state == .ended {
            handleDragOppositeCell = nil
            handleDragStartCell = nil
            handleDragStartLocation = nil
            handleDragTouchOffset = nil
            presentCopyMenuIfSelectionExists()
        }
    }

}
