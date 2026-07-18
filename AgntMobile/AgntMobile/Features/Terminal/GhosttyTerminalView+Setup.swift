// FILE: GhosttyTerminalView+Setup.swift
// Purpose: View hierarchy and app lifecycle wiring for GhosttyTerminalView.
// Layer: View Infrastructure

import GhosttyKit
import UIKit

extension GhosttyTerminalView {
    func configureViewHierarchy() {
        applyTheme()
        clipsToBounds = true
        contentScaleFactor = UIScreen.main.scale

        terminalViewport.clipsToBounds = true
        terminalViewport.contentScaleFactor = contentScaleFactor
        terminalViewport.translatesAutoresizingMaskIntoConstraints = false
        terminalViewport.isUserInteractionEnabled = true

        selectionOverlay.translatesAutoresizingMaskIntoConstraints = false
        selectionOverlay.backgroundColor = .clear
        selectionOverlay.isOpaque = false
        selectionOverlay.isUserInteractionEnabled = true
        selectionOverlay.onHandleDrag = { [weak self] handle, location, state in
            self?.handleSelectionHandleDrag(handle, location: location, state: state)
        }

        inputField.delegate = self
        inputField.backgroundColor = .clear
        inputField.textColor = .clear
        inputField.tintColor = .clear
        inputField.font = UIFont.monospacedSystemFont(ofSize: max(fontSize, 13), weight: .regular)
        inputField.autocorrectionType = .no
        inputField.autocapitalizationType = .none
        inputField.spellCheckingType = .no
        inputField.smartDashesType = .no
        inputField.smartQuotesType = .no
        inputField.returnKeyType = .default
        inputField.keyboardType = .asciiCapable
        inputField.enablesReturnKeyAutomatically = false
        inputField.translatesAutoresizingMaskIntoConstraints = false
        inputField.alpha = 0.02
        inputField.isAccessibilityElement = false
        inputField.accessibilityElementsHidden = true
        inputField.addTarget(self, action: #selector(handleInputEditingDidBegin), for: .editingDidBegin)
        inputField.onDeleteBackward = { [weak self] in
            self?.emitInput(Data([0x7F]))
        }

        focusTapGesture.addTarget(self, action: #selector(handleViewportTap))
        focusTapGesture.require(toFail: selectionLongPressGesture)
        terminalViewport.addGestureRecognizer(focusTapGesture)

        scrollPanGesture.addTarget(self, action: #selector(handleViewportPan(_:)))
        scrollPanGesture.maximumNumberOfTouches = 1
        scrollPanGesture.cancelsTouchesInView = false
        scrollPanGesture.delegate = self
        terminalViewport.addGestureRecognizer(scrollPanGesture)

        selectionLongPressGesture.addTarget(self, action: #selector(handleTextSelectionLongPress(_:)))
        selectionLongPressGesture.minimumPressDuration = 0.35
        selectionLongPressGesture.allowableMovement = 18
        selectionLongPressGesture.cancelsTouchesInView = false
        selectionLongPressGesture.delegate = self
        terminalViewport.addGestureRecognizer(selectionLongPressGesture)
        terminalViewport.addInteraction(selectionEditMenuInteraction)

        addSubview(terminalViewport)
        addSubview(selectionOverlay)
        addSubview(inputField)

        NSLayoutConstraint.activate([
            terminalViewport.leadingAnchor.constraint(equalTo: leadingAnchor),
            terminalViewport.trailingAnchor.constraint(equalTo: trailingAnchor),
            terminalViewport.topAnchor.constraint(equalTo: topAnchor),
            terminalViewport.bottomAnchor.constraint(equalTo: bottomAnchor),

            selectionOverlay.leadingAnchor.constraint(equalTo: terminalViewport.leadingAnchor),
            selectionOverlay.trailingAnchor.constraint(equalTo: terminalViewport.trailingAnchor),
            selectionOverlay.topAnchor.constraint(equalTo: terminalViewport.topAnchor),
            selectionOverlay.bottomAnchor.constraint(equalTo: terminalViewport.bottomAnchor),

            inputField.trailingAnchor.constraint(equalTo: trailingAnchor),
            inputField.topAnchor.constraint(equalTo: bottomAnchor, constant: 8),
            inputField.widthAnchor.constraint(equalToConstant: 1),
            inputField.heightAnchor.constraint(equalToConstant: 1),
        ])

        registerApplicationLifecycleNotifications()
    }

    func registerApplicationLifecycleNotifications() {
        isRendererSuspended = UIApplication.shared.applicationState != .active
        let center = NotificationCenter.default
        center.addObserver(
            self,
            selector: #selector(handleApplicationWillResignActive),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(handleApplicationDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(handleApplicationDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    // MARK: - App Visibility

    @objc func handleApplicationWillResignActive() {
        suspendRendererForAppBackground()
    }

    @objc func handleApplicationDidEnterBackground() {
        suspendRendererForAppBackground()
    }

    @objc func handleApplicationDidBecomeActive() {
        resumeRendererForActiveApp()
    }

    var canRenderSurface: Bool {
        window != nil && !isRendererSuspended
    }

    // Keeps Ghostty away from IOSurface drawing/input focus while UIKit is
    // backgrounding the scene; SSH output can still accumulate in the buffer.
    func suspendRendererForAppBackground() {
        guard !isRendererSuspended else { return }
        isRendererSuspended = true
        inputField.resignFirstResponder()
        updateSurfaceRuntimeVisibility()
    }

    func resumeRendererForActiveApp() {
        guard isRendererSuspended else { return }
        isRendererSuspended = false
        updateSurfaceRuntimeVisibility()
        guard window != nil else { return }
        if surface == nil {
            createSurfaceIfPossible()
        }
        resizeSurface()
        applyRemoteBuffer(initialBuffer)
        requestKeyboardFocus()
    }

    func updateSurfaceRuntimeVisibility() {
        let isVisible = canRenderSurface
        if let app {
            ghostty_app_set_focus(app, isVisible)
        }
        if let surface {
            ghostty_surface_set_focus(surface, isVisible)
            ghostty_surface_set_occlusion(surface, isVisible)
        }
    }

    // MARK: - Input

}
