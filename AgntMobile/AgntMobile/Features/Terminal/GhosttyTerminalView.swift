// FILE: GhosttyTerminalView.swift
// Purpose: UIKit-backed Ghostty renderer that turns bridge SSH output into an interactive iOS terminal.
// Layer: View Infrastructure
// Exports: GhosttyTerminalView
// Depends on: GhosttyKit, UIKit, QuartzCore

import Foundation
import GhosttyKit
import QuartzCore
import UIKit

enum GhosttyRuntime {
    static let lock = NSLock()
    static var initialized = false

    // Ghostty's C runtime must be initialized once before any app/surface is created.
    static func ensureInitialized() -> Bool {
        lock.lock()
        defer { lock.unlock() }

        if initialized {
            return true
        }

        let result = ghostty_init(0, nil)
        initialized = result == GHOSTTY_SUCCESS
        return initialized
    }
}

final class TerminalInputField: UITextField {
    var onDeleteBackward: (() -> Void)?

    override func deleteBackward() {
        onDeleteBackward?()
        super.deleteBackward()
    }
}

enum TerminalAppearanceScheme: String {
    case light
    case dark

    init(value: String) {
        self = TerminalAppearanceScheme(rawValue: value) ?? .dark
    }

    var ghosttyColorScheme: ghostty_color_scheme_e {
        switch self {
        case .light:
            return GHOSTTY_COLOR_SCHEME_LIGHT
        case .dark:
            return GHOSTTY_COLOR_SCHEME_DARK
        }
    }
}

extension UIColor {
    convenience init(hexString: String) {
        let sanitized = hexString.replacingOccurrences(of: "#", with: "")
        let value = Int(sanitized, radix: 16) ?? 0
        self.init(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }
}

final class GhosttyTerminalView: UIView, UITextFieldDelegate, UIGestureRecognizerDelegate, UIEditMenuInteractionDelegate {
    static let minimumVerticalScrollStepPoints: CGFloat = 18
    static let verticalScrollStepMultiplier: CGFloat = 1.15
    static let selectionDragActivationDistance: CGFloat = 10
    static let minimumDrawableViewportSize = CGSize(width: 24, height: 24)
    static let terminalResetSequence = Data("\u{1B}c".utf8)
    static let terminalReturnSequence = Data([0x0D])

    let terminalViewport = UIView()
    let selectionOverlay = TerminalSelectionOverlayView()
    let inputField = TerminalInputField()
    let focusTapGesture = UITapGestureRecognizer()
    let scrollPanGesture = UIPanGestureRecognizer()
    let selectionLongPressGesture = UILongPressGestureRecognizer()
    // Created during view hierarchy setup so teardown paths never instantiate UIKit interactions.
    var selectionEditMenuInteraction: UIEditMenuInteraction?
    var lastViewportSize: CGSize = .zero
    var lastContentScale: CGFloat = 0
    var lastReportedGrid: (cols: Int, rows: Int)?
    var lastAppliedBuffer = Data()
    var pendingVerticalScrollPoints: CGFloat = 0
    var isSelectingText = false
    var selectionAnchorCell: TerminalSelectionCell?
    var selectionFocusCell: TerminalSelectionCell?
    var handleDragOppositeCell: TerminalSelectionCell?
    var handleDragStartCell: TerminalSelectionCell?
    var handleDragStartLocation: CGPoint?
    var handleDragTouchOffset: CGPoint?
    var selectionGestureStartPoint: CGPoint?
    var selectionGestureDidDrag = false
    var selectedTextForEditMenu = ""
    var selectionMenuTargetRect: CGRect?
    var app: ghostty_app_t?
    var surface: ghostty_surface_t?
    var isCreatingSurface = false
    var surfaceCreationFailed = false
    var isRendererSuspended = false
    var appearance = TerminalAppearanceScheme.dark
    var backgroundColorValue = UIColor(hexString: "#0a0a0a")

    var onInput: ((Data) -> Void)?
    var onResize: ((Int, Int) -> Void)?
    var onNativeAvailabilityChanged: ((Bool) -> Void)?

    var terminalKey: String = "" {
        didSet {
            accessibilityIdentifier = "agnt-terminal-\(terminalKey)"
        }
    }

    var initialBuffer: Data = Data() {
        didSet {
            guard oldValue != initialBuffer else { return }
            applyRemoteBuffer(initialBuffer)
        }
    }

    var fontSize: CGFloat = 10 {
        didSet {
            guard oldValue != fontSize else { return }
            inputField.font = UIFont.monospacedSystemFont(ofSize: max(fontSize, 13), weight: .regular)
            refreshSurface()
        }
    }

    var appearanceScheme: String = TerminalAppearanceScheme.dark.rawValue {
        didSet {
            guard oldValue != appearanceScheme else { return }
            appearance = TerminalAppearanceScheme(value: appearanceScheme)
            refreshSurface()
        }
    }

    var themeConfig: String = "" {
        didSet {
            guard oldValue != themeConfig else { return }
            refreshSurface()
        }
    }

    var backgroundColorHex: String = "#0a0a0a" {
        didSet {
            backgroundColorValue = UIColor(hexString: backgroundColorHex)
            applyTheme()
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        configureViewHierarchy()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configureViewHierarchy()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        destroySurface()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        updateContentScale()

        let viewportSize = terminalViewport.bounds.size
        guard Self.isDrawableViewportSize(viewportSize) else {
            lastViewportSize = viewportSize
            return
        }

        if surface == nil {
            createSurfaceIfPossible()
        }

        guard viewportSize != lastViewportSize || contentScaleFactor != lastContentScale else {
            return
        }

        lastViewportSize = viewportSize
        lastContentScale = contentScaleFactor
        resizeSurface()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        updateSurfaceRuntimeVisibility()
        guard window != nil else {
            inputField.resignFirstResponder()
            return
        }
        if surface != nil {
            resizeSurface()
        } else {
            setNeedsLayout()
        }
        DispatchQueue.main.async { [weak self] in
            guard self?.canRenderSurface == true else { return }
            self?.requestKeyboardFocus()
        }
    }

    func textField(
        _ textField: UITextField,
        shouldChangeCharactersIn range: NSRange,
        replacementString string: String
    ) -> Bool {
        if !string.isEmpty {
            emitInput(Self.terminalInputData(for: string))
        }
        return false
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        emitInput(Self.terminalReturnSequence)
        textField.text = ""
        return false
    }

    static func isDrawableViewportSize(_ size: CGSize) -> Bool {
        size.width >= minimumDrawableViewportSize.width
            && size.height >= minimumDrawableViewportSize.height
    }

    // MARK: - Setup
}
