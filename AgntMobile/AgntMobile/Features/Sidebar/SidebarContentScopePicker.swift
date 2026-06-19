// FILE: SidebarContentScopePicker.swift
// Purpose: Segmented capsule that switches the sidebar between project-backed
//          threads and rootless chats.
// Layer: View Component
// Exports: SidebarContentScopePicker
// Depends on: SwiftUI, SidebarContentScope, AppFont, HapticFeedback

import SwiftUI

struct SidebarContentScopePicker: View {
    @Binding var selection: SidebarContentScope

    @Namespace private var thumbNamespace

    private static let selectionAnimation: Animation = .spring(response: 0.32, dampingFraction: 0.8)

    var body: some View {
        HStack(spacing: 4) {
            ForEach(SidebarContentScope.allCases) { scope in
                segment(scope)
            }
        }
        .padding(4)
        .background(
            Capsule(style: .continuous)
                .fill(Color(.secondarySystemBackground))
        )
        .frame(maxWidth: .infinity)
        .animation(Self.selectionAnimation, value: selection)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sidebar content scope")
    }

    @ViewBuilder
    private func segment(_ scope: SidebarContentScope) -> some View {
        let isSelected = selection == scope

        Button {
            guard selection != scope else { return }
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            withAnimation(Self.selectionAnimation) {
                selection = scope
            }
        } label: {
            Text(scope.title)
                .font(AppFont.subheadline(weight: isSelected ? .semibold : .medium))
                .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .background {
                    if isSelected {
                        Capsule(style: .continuous)
                            .fill(Color(.systemBackground))
                            .shadow(color: .black.opacity(0.12), radius: 3, y: 1)
                            .matchedGeometryEffect(id: "scopeThumb", in: thumbNamespace)
                    }
                }
                .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(scope.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

// MARK: - Previews

#if DEBUG
private struct SidebarContentScopePickerPreviewHost: View {
    @State private var selection: SidebarContentScope = .projects

    var body: some View {
        VStack(spacing: 24) {
            SidebarContentScopePicker(selection: $selection)
            Text("Selected: \(selection.title)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(20)
    }
}

#Preview("Scope Picker — Light") {
    SidebarContentScopePickerPreviewHost()
        .preferredColorScheme(.light)
}

#Preview("Scope Picker — Dark") {
    SidebarContentScopePickerPreviewHost()
        .preferredColorScheme(.dark)
}
#endif
