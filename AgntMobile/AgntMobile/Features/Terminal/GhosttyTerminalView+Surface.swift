// FILE: GhosttyTerminalView+Surface.swift
// Purpose: Ghostty surface lifecycle, buffering, resize, and theme plumbing.
// Layer: View Infrastructure

import Foundation
import GhosttyKit
import QuartzCore
import UIKit

extension GhosttyTerminalView {

    func createSurfaceIfPossible() {
        guard surface == nil, app == nil, !isCreatingSurface, !surfaceCreationFailed else { return }
        guard terminalViewport.bounds.width > 0, terminalViewport.bounds.height > 0 else { return }
        guard canRenderSurface else { return }
        guard GhosttyRuntime.ensureInitialized() else {
            markSurfaceCreationFailed()
            return
        }

        isCreatingSurface = true
        defer { isCreatingSurface = false }

        var runtimeConfig = ghostty_runtime_config_s(
            userdata: Unmanaged.passUnretained(self).toOpaque(),
            supports_selection_clipboard: false,
            wakeup_cb: { _ in },
            action_cb: { _, _, _ in false },
            read_clipboard_cb: { userdata, _, state in
                guard let userdata else { return false }
                let view = Unmanaged<GhosttyTerminalView>.fromOpaque(userdata).takeUnretainedValue()
                return view.completeClipboardRead(state: state)
            },
            confirm_read_clipboard_cb: { _, _, _, _ in },
            write_clipboard_cb: { userdata, _, contents, count, _ in
                guard let userdata else { return }
                let view = Unmanaged<GhosttyTerminalView>.fromOpaque(userdata).takeUnretainedValue()
                view.writeClipboard(contents: contents, count: count)
            },
            close_surface_cb: { _, _ in }
        )

        guard let config = ghostty_config_new() else {
            markSurfaceCreationFailed()
            return
        }
        loadThemeConfig(into: config)
        ghostty_config_finalize(config)
        defer { ghostty_config_free(config) }

        guard let createdApp = ghostty_app_new(&runtimeConfig, config) else {
            markSurfaceCreationFailed()
            return
        }

        var surfaceConfig = ghostty_surface_config_new()
        surfaceConfig.platform_tag = GHOSTTY_PLATFORM_IOS
        surfaceConfig.platform.ios.uiview = Unmanaged.passUnretained(terminalViewport).toOpaque()
        surfaceConfig.userdata = Unmanaged.passUnretained(self).toOpaque()
        surfaceConfig.scale_factor = Double(contentScaleFactor)
        surfaceConfig.font_size = Float(fontSize)
        surfaceConfig.context = GHOSTTY_SURFACE_CONTEXT_WINDOW
        surfaceConfig.use_custom_io = true

        guard let createdSurface = ghostty_surface_new(createdApp, &surfaceConfig) else {
            ghostty_app_free(createdApp)
            markSurfaceCreationFailed()
            return
        }

        app = createdApp
        surface = createdSurface
        onNativeAvailabilityChanged?(true)
        ghostty_app_set_color_scheme(createdApp, appearance.ghosttyColorScheme)
        ghostty_surface_set_color_scheme(createdSurface, appearance.ghosttyColorScheme)
        setupWriteCallback()
        updateSurfaceRuntimeVisibility()
        resizeSurface()
        feedBuffer(initialBuffer)
    }

    func resetSurface() {
        destroySurface()
        lastAppliedBuffer = Data()
        lastViewportSize = .zero
        lastContentScale = 0
        lastReportedGrid = nil
        surfaceCreationFailed = false
        setNeedsLayout()
    }

    func markSurfaceCreationFailed() {
        surfaceCreationFailed = true
        onNativeAvailabilityChanged?(false)
    }

    func refreshSurface() {
        resetSurface()
        createSurfaceIfPossible()
    }

    func destroySurface() {
        clearAppSelection()
        if let surface {
            ghostty_surface_set_write_callback(surface, nil, nil)
            ghostty_surface_free(surface)
        }
        if let app {
            ghostty_app_free(app)
        }
        surface = nil
        app = nil
    }

    func applyRemoteBuffer(_ buffer: Data) {
        guard canRenderSurface else { return }
        guard surface != nil else {
            createSurfaceIfPossible()
            return
        }

        if Data(buffer.prefix(lastAppliedBuffer.count)) == lastAppliedBuffer {
            let suffix = Data(buffer.dropFirst(lastAppliedBuffer.count))
            feedData(suffix)
            lastAppliedBuffer = buffer
            return
        }

        replaceRenderedBuffer(with: buffer)
    }

    func feedBuffer(_ buffer: Data) {
        guard canRenderSurface, !buffer.isEmpty else { return }
        feedData(buffer)
        lastAppliedBuffer = buffer
    }

    func replaceRenderedBuffer(with buffer: Data) {
        guard canRenderSurface else { return }
        guard surface != nil else {
            lastAppliedBuffer = Data()
            createSurfaceIfPossible()
            feedBuffer(buffer)
            return
        }

        feedData(Self.terminalResetSequence)
        lastAppliedBuffer = Data()
        feedBuffer(buffer)
    }

    func feedData(_ data: Data) {
        guard canRenderSurface, let surface, !data.isEmpty else { return }

        data.withUnsafeBytes { buffer in
            guard let pointer = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
                return
            }
            ghostty_surface_feed_data(surface, pointer, buffer.count)
        }

        redrawSurface()
    }

    func setupWriteCallback() {
        guard let surface else { return }

        let userdata = Unmanaged.passUnretained(self).toOpaque()
        ghostty_surface_set_write_callback(surface, { userdata, data, len in
            guard let userdata, let data, len > 0 else { return }
            let view = Unmanaged<GhosttyTerminalView>.fromOpaque(userdata).takeUnretainedValue()
            let bytes = Data(bytes: data, count: len)

            DispatchQueue.main.async {
                view.onInput?(bytes)
            }
        }, userdata)
    }

    func resizeSurface() {
        guard let surface else {
            emitEstimatedResize()
            return
        }

        let scale = contentScaleFactor
        let width = UInt32(max(floor(terminalViewport.bounds.width * scale), 1))
        let height = UInt32(max(floor(terminalViewport.bounds.height * scale), 1))

        terminalViewport.contentScaleFactor = scale
        ghostty_surface_set_content_scale(surface, Double(scale), Double(scale))
        ghostty_surface_set_size(surface, width, height)
        updateSurfaceRuntimeVisibility()
        guard canRenderSurface else { return }
        configureIOSurfaceLayers()
        redrawSurface()
        emitGhosttyResize()
        updateSelectionOverlay()
    }

    func redrawSurface() {
        guard let surface else { return }
        guard canRenderSurface else { return }
        ghostty_surface_refresh(surface)
        ghostty_surface_draw(surface)
        markIOSurfaceLayersForDisplay()
        emitGhosttyResize()
    }

    func emitGhosttyResize() {
        guard let surface else {
            emitEstimatedResize()
            return
        }

        let size = ghostty_surface_size(surface)
        emitResize(cols: max(1, Int(size.columns)), rows: max(1, Int(size.rows)))
    }

    func emitEstimatedResize() {
        guard bounds.width > 0, bounds.height > 0 else { return }

        let cellWidth = max(fontSize * 0.62, 1)
        let cellHeight = max(fontSize * 1.35, 1)
        emitResize(
            cols: max(20, min(400, Int(bounds.width / cellWidth))),
            rows: max(5, min(200, Int(bounds.height / cellHeight)))
        )
    }

    func emitResize(cols: Int, rows: Int) {
        guard lastReportedGrid?.cols != cols || lastReportedGrid?.rows != rows else {
            return
        }

        lastReportedGrid = (cols, rows)
        onResize?(cols, rows)
    }

    func updateContentScale() {
        let scale = window?.screen.scale ?? UIScreen.main.scale
        if contentScaleFactor != scale {
            contentScaleFactor = scale
        }
    }

    func configureIOSurfaceLayers() {
        let targetBounds = CGRect(origin: .zero, size: terminalViewport.bounds.size)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        terminalViewport.layer.sublayers?.forEach { sublayer in
            sublayer.frame = targetBounds
            sublayer.contentsScale = contentScaleFactor
        }
        CATransaction.commit()
    }

    func markIOSurfaceLayersForDisplay() {
        terminalViewport.layer.setNeedsDisplay()
        terminalViewport.layer.sublayers?.forEach { layer in
            layer.setNeedsDisplay()
        }
    }

    func applyTheme() {
        backgroundColor = backgroundColorValue
        terminalViewport.backgroundColor = backgroundColorValue
    }

    func loadThemeConfig(into config: ghostty_config_t) {
        guard let path = writeThemeConfigFile() else { return }
        path.withCString { cString in
            ghostty_config_load_file(config, cString)
        }
    }

    func writeThemeConfigFile() -> String? {
        guard !themeConfig.isEmpty else { return nil }
        let configContents = themeConfig
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("agnt-terminal-theme-\(appearance.rawValue).ghostty")

        do {
            if let existing = try? String(contentsOf: url, encoding: .utf8), existing == configContents {
                return url.path
            }

            try configContents.write(to: url, atomically: true, encoding: .utf8)
            return url.path
        } catch {
            return nil
        }
    }
}
