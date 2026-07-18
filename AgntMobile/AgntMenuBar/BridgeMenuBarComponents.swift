// FILE: BridgeMenuBarComponents.swift
// Purpose: Provides reusable small controls for the menu bar companion UI.
// Layer: Companion app view
// Exports: LabelValueRow, CompactActionButton
// Depends on: SwiftUI

import SwiftUI

struct LabelValueRow: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.system(size: 10, weight: .regular, design: .monospaced))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
        }
    }
}

struct CompactActionButton: View {
    let title: String
    let style: Style
    let action: () -> Void

    enum Style { case primary, secondary, destructive }

    init(_ title: String, style: Style = .secondary, action: @escaping () -> Void) {
        self.title = title
        self.style = style
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(foregroundColor)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .background(backgroundColor, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(borderColor, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }

    private var backgroundColor: Color {
        switch style {
        case .primary, .secondary, .destructive: return .clear
        }
    }

    private var foregroundColor: Color {
        switch style {
        case .primary: return .primary
        case .secondary: return .primary
        case .destructive: return .red
        }
    }

    private var borderColor: Color {
        switch style {
        case .primary: return .primary.opacity(0.18)
        case .secondary: return .primary.opacity(0.08)
        case .destructive: return .red.opacity(0.15)
        }
    }
}
