// FILE: TurnTimelineFooterViews.swift
// Purpose: Hosts pending assistant and footer support views for TurnTimelineView.
// Layer: View Component
// Depends on: SwiftUI, TurnErrorReportCard, TurnFloatingButtonPressStyle

import SwiftUI

struct PendingAssistantIndicatorRow: View {
    var body: some View {
        HStack {
            TerminalRunningIndicator()
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
        .padding(.top, 6)
    }
}

struct TurnTimelineFooterContainer<Composer: View>: View {
    let hidesErrorMessage: Bool
    let errorMessage: String?
    let onReportError: (String) -> Void
    let onDismissError: () -> Void
    let shouldShowScrollToLatestButton: Bool
    let scrollToLatestButtonLift: CGFloat
    let onScrollToLatest: (() -> Void)?
    @ViewBuilder let composer: () -> Composer

    var body: some View {
        let footerContent = VStack(spacing: 0) {
            if !hidesErrorMessage, let errorMessage, !errorMessage.isEmpty {
                TurnErrorReportCard(
                    message: errorMessage,
                    onReport: { onReportError(errorMessage) },
                    onDismiss: onDismissError
                )
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }

            composer()
        }

        footerContent
            .overlay(alignment: .top) {
                if shouldShowScrollToLatestButton, let onScrollToLatest {
                    scrollToLatestButton(action: onScrollToLatest)
                        .offset(y: -scrollToLatestButtonLift)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: shouldShowScrollToLatestButton)
    }

    private func scrollToLatestButton(action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(AppFont.system(size: 13, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 34, height: 34)
                .adaptiveGlass(.regular, in: Circle())
        }
        .frame(width: 44, height: 44)
        .buttonStyle(TurnFloatingButtonPressStyle())
        .contentShape(Circle())
        .accessibilityLabel("Scroll to latest message")
        .transition(.opacity.combined(with: .scale(scale: 0.85)))
    }
}
