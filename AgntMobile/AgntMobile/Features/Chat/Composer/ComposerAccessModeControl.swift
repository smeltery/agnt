// FILE: ComposerAccessModeControl.swift
// Purpose: Presents the composer access-mode control and its selection popover.
// Layer: View Component
// Exports: ComposerAccessModeControl
// Depends on: SwiftUI, CodexAccessMode, AppFont

import SwiftUI

struct ComposerAccessModeControl: View {
    let selectedAccessMode: CodexAccessMode
    let isInteractionLocked: Bool
    let onSelect: (CodexAccessMode) -> Void

    private let controlSize: CGFloat = 32
    private let iconSize: CGFloat = 15

    @State private var showsPopover = false

    var body: some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            showsPopover = true
        } label: {
            Image(systemName: selectedAccessMode.composerIconSystemName)
                .font(AppFont.system(size: iconSize, weight: .regular))
                .foregroundStyle(selectedAccessMode.composerTint)
                .frame(width: controlSize, height: controlSize)
                .contentShape(Circle())
        }
        .tint(Color(.secondaryLabel))
        .disabled(isInteractionLocked)
        .accessibilityLabel(selectedAccessMode.pickerTitle)
        .accessibilityHint("Changes how the agent requests permission")
        .popover(isPresented: $showsPopover, arrowEdge: .bottom) {
            ComposerAccessModePopover(
                selectedAccessMode: selectedAccessMode,
                onSelect: { mode in
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    showsPopover = false
                    onSelect(mode)
                }
            )
        }
    }
}

private extension CodexAccessMode {
    var composerIconSystemName: String {
        switch self {
        case .onRequest:
            return "hand.raised"
        case .autoReview:
            return "checkmark.shield"
        case .fullAccess:
            return "hand.thumbsup"
        }
    }

    var composerTint: Color {
        switch self {
        case .onRequest:
            return Color(.secondaryLabel)
        case .autoReview:
            return Color(.systemBlue)
        case .fullAccess:
            return .orange
        }
    }
}

private struct ComposerAccessModePopover: View {
    let selectedAccessMode: CodexAccessMode
    let onSelect: (CodexAccessMode) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(CodexAccessMode.allCases, id: \.rawValue) { mode in
                Button {
                    onSelect(mode)
                } label: {
                    ComposerAccessModeRow(
                        mode: mode,
                        isSelected: selectedAccessMode == mode
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(mode.pickerTitle)
                .accessibilityHint(mode.pickerSubtitle)
                .accessibilityAddTraits(selectedAccessMode == mode ? .isSelected : [])
            }
        }
        .padding(.vertical, 10)
        .frame(width: 312)
        .presentationCompactAdaptation(.popover)
    }
}

private struct ComposerAccessModeRow: View {
    let mode: CodexAccessMode
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: mode.composerIconSystemName)
                .font(AppFont.system(size: 18, weight: .semibold))
                .foregroundStyle(mode.composerTint)
                .frame(width: 28, height: 28)

            VStack(alignment: .leading, spacing: 2) {
                Text(mode.pickerTitle)
                    .font(AppFont.body())
                    .foregroundStyle(.primary)
                Text(mode.pickerSubtitle)
                    .font(AppFont.subheadline())
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .multilineTextAlignment(.leading)

            Spacer(minLength: 8)

            Image(systemName: "checkmark")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.primary)
                .opacity(isSelected ? 1 : 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}
