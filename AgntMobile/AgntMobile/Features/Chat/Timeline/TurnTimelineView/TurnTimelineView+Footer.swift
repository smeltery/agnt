import SwiftUI

extension TurnTimelineView {
    @ViewBuilder
    var emptyTimelineState: some View {
        if isThreadRunning {
            VStack(spacing: 12) {
                Spacer()
                ProgressView()
                    .controlSize(.large)
                Text("Working on it...")
                    .font(AppFont.title3(weight: .semibold))
                Text("The run is still active. You can stop it below if needed.")
                    .font(AppFont.body())
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
                Spacer()
            }
        } else {
            emptyState()
        }
    }

    // Keeps the composer/footer visually stable so scrolling does not animate the bottom inset.
    func footer(scrollToBottomAction: (() -> Void)? = nil) -> some View {
        TurnTimelineFooterContainer(
            hidesErrorMessage: hidesErrorMessage,
            errorMessage: errorMessage,
            onReportError: onReportError,
            onDismissError: onDismissError,
            shouldShowScrollToLatestButton: shouldShowScrollToLatestButton,
            scrollToLatestButtonLift: Self.scrollToLatestButtonLift,
            onScrollToLatest: scrollToBottomAction,
            composer: composer
        )
    }

    // Restores swipe-to-dismiss in brand-new chats without putting a drag
    // recognizer back on top of the composer footer itself.
    var emptyStateKeyboardDismissGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                guard isComposerFocused else { return }
                guard abs(value.translation.height) > abs(value.translation.width) else { return }
                guard value.translation.height < -20 else { return }
                onTapOutsideComposer()
            }
    }
    var timelineLoadingOverlay: some View {
        VStack(spacing: 12) {
            Spacer()
            ProgressView()
                .controlSize(.large)
            Text("Loading chat...")
                .font(AppFont.title3(weight: .semibold))
            Text("Preparing recent messages for this conversation.")
                .font(AppFont.body())
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 28)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}
