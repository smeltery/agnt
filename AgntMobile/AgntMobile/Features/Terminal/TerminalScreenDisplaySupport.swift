// FILE: TerminalScreenDisplaySupport.swift
// Purpose: Pure display-name helpers for the terminal route.
// Layer: View support
// Exports: Terminal route display helpers
// Depends on: Foundation

import Foundation

func terminalFirstNonEmpty(_ values: [String?]) -> String? {
    for value in values {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty {
            return trimmed
        }
    }
    return nil
}

func terminalProjectDisplayName(for path: String) -> String? {
    let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    return URL(fileURLWithPath: trimmed).lastPathComponent
}

func terminalDisplayLabel(for terminalId: String) -> String {
    let index = terminalIndex(for: terminalId)
    guard index > 1 else { return "Terminal" }
    return "Terminal \(index)"
}

func terminalNextOpenTerminalId(from terminalIds: [String]) -> String {
    let existingIndexes = terminalIds.map { terminalIndex(for: $0) }
    let nextIndex = (existingIndexes.max() ?? 0) + 1
    return "term-\(max(1, nextIndex))"
}

func terminalStatusLabel(for status: AgntTerminalStatus) -> String {
    switch status {
    case .running:
        return "Running"
    case .starting:
        return "Starting"
    case .error:
        return "Error"
    case .exited:
        return "Exited"
    case .closed:
        return "Closed"
    case .idle:
        return "Idle"
    }
}

func terminalStatusTone(for status: AgntTerminalStatus) -> TerminalStatusTone {
    switch status {
    case .running:
        return TerminalStatusTone(tint: "#34d399", text: "#a3a3a3")
    case .starting:
        return TerminalStatusTone(tint: "#f59e0b", text: "#a3a3a3")
    case .error:
        return TerminalStatusTone(tint: "#ef4444", text: "#fca5a5")
    case .idle, .closed, .exited:
        return TerminalStatusTone(tint: "#ef4444", text: "#a3a3a3")
    }
}

func buildTerminalToolbarActions(for hostPlatform: TerminalHostPlatform) -> [TerminalToolbarAction] {
    let modifierActions: [TerminalToolbarAction]
    switch hostPlatform {
    case .mac:
        modifierActions = [
            TerminalToolbarAction(kind: .modifier(.meta), key: "cmd", label: "cmd"),
            TerminalToolbarAction(kind: .modifier(.ctrl), key: "ctrl", label: "ctrl"),
        ]
    case .linux, .windows, .unknown:
        modifierActions = [
            TerminalToolbarAction(kind: .modifier(.ctrl), key: "ctrl", label: "ctrl"),
            TerminalToolbarAction(kind: .modifier(.meta), key: "alt", label: "alt"),
        ]
    }

    return [
        TerminalToolbarAction(kind: .send("\u{1B}"), key: "esc", label: "esc"),
    ] + modifierActions + [
        TerminalToolbarAction(kind: .send("\t"), key: "tab", label: "tab"),
        TerminalToolbarAction(kind: .send("\u{1B}[A"), key: "up", label: "↑"),
        TerminalToolbarAction(kind: .send("\u{1B}[B"), key: "down", label: "↓"),
        TerminalToolbarAction(kind: .send("\u{1B}[D"), key: "left", label: "←"),
        TerminalToolbarAction(kind: .send("\u{1B}[C"), key: "right", label: "→"),
        TerminalToolbarAction(kind: .send("~"), key: "tilde", label: "~"),
        TerminalToolbarAction(kind: .send("|"), key: "pipe", label: "|"),
        TerminalToolbarAction(kind: .send("/"), key: "slash", label: "/"),
        TerminalToolbarAction(kind: .send("-"), key: "dash", label: "-"),
    ]
}

func buildTerminalMenuSessions(
    from snapshots: [AgntTerminalSnapshot],
    activeTerminalId: String
) -> [TerminalMenuSessionItem] {
    snapshots.filter { snapshot in
        snapshot.terminalId == activeTerminalId || snapshot.status.isRunning
    }.map { snapshot in
        TerminalMenuSessionItem(
            terminalId: snapshot.terminalId,
            displayLabel: terminalDisplayLabel(for: snapshot.terminalId),
            status: snapshot.status,
            cwd: snapshot.cwd
        )
    }
}

func terminalErrorText(from error: Error) -> String {
    if case CodexServiceError.rpcError(let rpcError) = error {
        return rpcError.message
    }
    if let localizedError = error as? LocalizedError,
       let description = localizedError.errorDescription {
        return description
    }
    return error.localizedDescription
}

private func terminalIndex(for terminalId: String) -> Int {
    guard terminalId.hasPrefix("term-"),
          let value = Int(terminalId.dropFirst(5)) else {
        return 1
    }
    return value
}
