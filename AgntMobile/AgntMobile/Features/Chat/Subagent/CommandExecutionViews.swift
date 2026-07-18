// FILE: CommandExecutionViews.swift
// Purpose: Inline command execution row, humanizer, and detail sheet.
// Layer: View Components
// Exports: CommandExecutionCardBody, CommandExecutionDetailSheet, CommandExecutionStatusModel, CommandExecutionStatusAccent, CommandHumanizer
// Depends on: SwiftUI, CommandExecutionDetails, AppFont

import SwiftUI

// MARK: - Models

enum CommandExecutionStatusAccent: String {
    case running
    case completed
    case failed

    // Keep tool-call status colors aligned with the inline command language used elsewhere in the app.
    private static let commandColor = Color(.command)

    var color: Color {
        switch self {
        case .running:
            return Self.commandColor
        case .completed:
            return .secondary
        case .failed:
            return .red
        }
    }
}

struct CommandExecutionStatusModel {
    let command: String
    let statusLabel: String
    let accent: CommandExecutionStatusAccent
}

struct CommandOutputImageReference: Identifiable, Equatable {
    let path: String

    var id: String { path }

    var fileName: String { path.pathDisplayName }
}
