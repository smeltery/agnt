// FILE: TerminalRouteSurface.swift
// Purpose: Terminal route content surface switching between native, fallback, and setup states.
// Layer: View
// Exports: TerminalRouteSurface
// Depends on: GhosttyTerminalSurface, TerminalFallbackSurface, TerminalRouteChrome

import SwiftUI

struct TerminalRouteSurface: View {
    let hasConnectionConfiguration: Bool
    let isNativeTerminalAvailable: Bool
    let terminalKey: String
    let snapshot: AgntTerminalSnapshot
    let fontSize: CGFloat
    let colorScheme: ColorScheme
    let theme: AgntTerminalTheme
    let isRunning: Bool
    let textReader: GhosttyTerminalTextReader
    let onShowConnectionEditor: () -> Void
    let onDataInput: (Data) -> Void
    let onTextInput: (String) -> Void
    let onResize: (Int, Int) -> Void
    let onNativeAvailabilityChanged: (Bool) -> Void

    var body: some View {
        if !hasConnectionConfiguration {
            TerminalRouteUnavailableView(
                title: "Terminal unavailable",
                detail: "SSH connection and key are required before opening a shell.",
                theme: theme,
                action: onShowConnectionEditor
            )
        } else if isNativeTerminalAvailable {
            GhosttyTerminalSurface(
                terminalKey: terminalKey,
                buffer: snapshot.bufferData,
                fontSize: fontSize,
                colorScheme: colorScheme,
                theme: theme,
                onInput: onDataInput,
                onResize: onResize,
                onNativeAvailabilityChanged: onNativeAvailabilityChanged,
                textReader: textReader
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(8)
        } else {
            TerminalFallbackSurface(
                snapshot: snapshot,
                fontSize: fontSize,
                theme: theme,
                isRunning: isRunning,
                onInput: onTextInput,
                onResize: onResize
            )
        }
    }
}
