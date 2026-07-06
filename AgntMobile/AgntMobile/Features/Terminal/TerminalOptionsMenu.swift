// FILE: TerminalOptionsMenu.swift
// Purpose: Encapsulates terminal status, clipboard, session, font-size, and connection actions.
// Layer: View Component
// Exports: TerminalOptionsMenu
// Depends on: SwiftUI, TerminalUIModels

import SwiftUI

struct TerminalOptionsMenu: View {
    let statusLabel: String
    let errorDetail: String?
    let statusTone: TerminalStatusTone
    let fontSize: Double
    let sessions: [TerminalMenuSessionItem]
    let activeTerminalId: String
    let isRunning: Bool
    let hasConnectionConfiguration: Bool
    let canPaste: Bool
    let canSelectText: Bool
    let canClear: Bool
    let canResetKnownHost: Bool
    let onSelectSession: (String) -> Void
    let onOpenNewTerminal: () -> Void
    let onToggleConnection: () -> Void
    let onOpenConnectionEditor: () -> Void
    let onPaste: () -> Void
    let onSelectText: () -> Void
    let onClear: () -> Void
    let onResetKnownHost: () -> Void
    let onAdjustFontSize: (Double) -> Void

    var body: some View {
        Menu {
            statusSection
            textSizeSection
            sessionSection
            clipboardSection
            connectionSection
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "circle.fill")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(Color(hexString: statusTone.tint))
                Text(statusLabel)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Color(hexString: statusTone.text))
            }
        }
        .accessibilityLabel("Terminal options")
    }

    private var statusSection: some View {
        Section {
            Text(statusLabel)
            if let errorDetail {
                Text(errorDetail)
            }
        }
    }

    private var textSizeSection: some View {
        Section("Text size") {
            Button("A- \(String(format: "%.1f", nextSmallerFontSize)) pt") {
                onAdjustFontSize(-agntTerminalFontSizeStep)
            }
            .disabled(fontSize <= agntTerminalMinFontSize)

            Button("A+ \(String(format: "%.1f", nextLargerFontSize)) pt") {
                onAdjustFontSize(agntTerminalFontSizeStep)
            }
            .disabled(fontSize >= agntTerminalMaxFontSize)
        }
    }

    private var sessionSection: some View {
        Section {
            ForEach(sessions) { session in
                Button {
                    onSelectSession(session.terminalId)
                } label: {
                    Label(
                        session.displayLabel,
                        systemImage: session.terminalId == activeTerminalId ? "checkmark" : "terminal"
                    )
                }
            }

            Button(action: onOpenNewTerminal) {
                Label("Open new terminal", systemImage: "plus")
            }
        }
    }

    private var clipboardSection: some View {
        Section {
            Button("Paste", systemImage: "doc.on.clipboard", action: onPaste)
                .disabled(!canPaste)

            Button("Select text", systemImage: "text.cursor", action: onSelectText)
                .disabled(!canSelectText)
        }
    }

    private var connectionSection: some View {
        Section {
            Button(
                isRunning ? "Disconnect" : "Connect",
                systemImage: isRunning ? "xmark" : "terminal",
                action: onToggleConnection
            )
            .disabled(!hasConnectionConfiguration && !isRunning)

            Button("SSH connection", systemImage: "lock.shield", action: onOpenConnectionEditor)

            Button("Clear", systemImage: "trash", action: onClear)
                .disabled(!canClear)

            Button("Reset host key", systemImage: "key", action: onResetKnownHost)
                .disabled(!canResetKnownHost)
        }
    }

    private var nextSmallerFontSize: Double {
        max(agntTerminalMinFontSize, fontSize - agntTerminalFontSizeStep)
    }

    private var nextLargerFontSize: Double {
        min(agntTerminalMaxFontSize, fontSize + agntTerminalFontSizeStep)
    }
}
