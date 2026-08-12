// FILE: SettingsComponents.swift
// Purpose: Shared settings card and button components.
// Layer: View

import SwiftUI
import UIKit

struct SettingsCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title.uppercased())
                .font(AppFont.caption(weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
                .padding(.bottom, 8)
            VStack(alignment: .leading, spacing: 12) {
                content
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.tertiarySystemFill).opacity(0.5), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }
}

struct SettingsButton: View {
    let title: String
    var role: ButtonRole?
    var isLoading: Bool = false
    let action: () -> Void

    init(_ title: String, role: ButtonRole? = nil, isLoading: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.role = role
        self.isLoading = isLoading
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Group {
                if isLoading {
                    ProgressView()
                } else {
                    Text(title)
                }
            }
            .font(AppFont.subheadline(weight: .medium))
            .foregroundStyle(role == .destructive ? .red : (role == .cancel ? .secondary : .primary))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(
                (role == .destructive ? Color.red : Color.primary).opacity(0.08),
                in: RoundedRectangle(cornerRadius: 10)
            )
        }
        .buttonStyle(.plain)
    }
}

struct SettingsMenuPickerOption<Value: Hashable>: Identifiable {
    let value: Value
    let title: String

    var id: Value { value }
}

// Native UIKit single-selection menu row. Replaces `Picker(selection:)
// .pickerStyle(.menu)` so the trigger gets UIKit's checkmark state and the
// shared `AppMenuPresentation` menu-row typography instead of SwiftUI's
// `Menu`, which doesn't expose either.
struct SettingsMenuPickerRow<Value: Hashable>: View {
    let title: String
    let value: String
    let options: [SettingsMenuPickerOption<Value>]
    @Binding var selection: Value
    var isDisabled = false

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            UIKitMenuButton {
                HStack(spacing: 6) {
                    Text(value)
                        .font(AppFont.subheadline())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)

                    Image(systemName: "chevron.up.chevron.down")
                        .font(AppFont.caption2(weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            } menu: {
                UIMenu(
                    options: [.singleSelection],
                    children: options.map { option in
                        UIAction(
                            title: option.title,
                            state: option.value == selection ? .on : .off
                        ) { _ in
                            selection = option.value
                        }
                    }
                )
            }
            .buttonStyle(.plain)
            .disabled(isDisabled || options.isEmpty)
        }
    }
}

// MARK: - Extracted independent section views
