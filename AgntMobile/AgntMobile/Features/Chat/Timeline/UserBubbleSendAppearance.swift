// FILE: UserBubbleSendAppearance.swift
// Purpose: Applies the local-send reveal animation to fresh optimistic user bubbles.
// Layer: View Support
// Exports: UserBubbleSendAppearance
// Depends on: SwiftUI

import SwiftUI

struct UserBubbleSendAppearance: ViewModifier {
    let isEnabled: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hasRevealed = false

    private var isConcealed: Bool {
        isEnabled && !hasRevealed
    }

    func body(content: Content) -> some View {
        content
            .opacity(isConcealed ? 0 : 1)
            .scaleEffect(
                isConcealed && !reduceMotion ? 0.9 : 1,
                anchor: .bottomTrailing
            )
            .offset(y: isConcealed && !reduceMotion ? 10 : 0)
            .onAppear {
                guard isEnabled, !hasRevealed else { return }
                let animation: Animation = reduceMotion
                    ? .easeOut(duration: 0.2)
                    : .spring(response: 0.34, dampingFraction: 0.82)
                withAnimation(animation) {
                    hasRevealed = true
                }
            }
    }
}
