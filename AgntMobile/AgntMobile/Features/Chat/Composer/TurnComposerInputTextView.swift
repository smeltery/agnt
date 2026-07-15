// FILE: TurnComposerInputTextView.swift
// Purpose: UIViewRepresentable wrapper for the composer text input and paste-image interception.
// Layer: View Component
// Exports: TurnComposerInputTextView
// Depends on: SwiftUI, UIKit, TurnComposerPasteTextView

import SwiftUI
import UIKit

struct TurnComposerInputTextView: UIViewRepresentable {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Binding var text: String
    @Binding var isFocused: Bool
    let isEditable: Bool
    @Binding var dynamicHeight: CGFloat
    let runtimeState: TurnComposerRuntimeState?
    let runtimeActions: TurnComposerRuntimeActions
    let maxVisibleLines: CGFloat
    let onPasteImageData: ([Data]) -> Void

    private let minVisibleLines: CGFloat = 1
    func makeUIView(context: Context) -> TurnComposerPasteInterceptingTextView {
        let textView = TurnComposerPasteInterceptingTextView(frame: .zero, textContainer: nil)
        textView.delegate = context.coordinator
        textView.backgroundColor = .clear
        textView.font = composerUIFont()
        textView.textColor = UIColor.label
        textView.typingAttributes[.font] = composerUIFont()
        textView.typingAttributes[.foregroundColor] = UIColor.label
        textView.adjustsFontForContentSizeCategory = true
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.textContainer.widthTracksTextView = true
        textView.autocorrectionType = .default
        textView.autocapitalizationType = .sentences
        textView.isScrollEnabled = false
        textView.showsVerticalScrollIndicator = false
        textView.alwaysBounceVertical = false
        // Keep drags inside the composer dedicated to editing and internal scrolling.
        textView.keyboardDismissMode = .none
        textView.onPasteImageData = onPasteImageData
        textView.runtimeState = runtimeState
        textView.runtimeActions = runtimeActions
        textView.setContentHuggingPriority(.defaultLow, for: .horizontal)
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        textView.accessibilityIdentifier = "turn.composer.input"
        context.coordinator.syncFocusIfNeeded(
            for: textView,
            shouldBeFocused: isFocused,
            isEditable: isEditable
        )
        context.coordinator.updateHeightIfNeeded(for: textView, force: true)
        return textView
    }

    func updateUIView(_ uiView: TurnComposerPasteInterceptingTextView, context: Context) {
        let nextFont = composerUIFont()
        let currentFont = uiView.font
        let fontChanged = currentFont?.fontName != nextFont.fontName
            || abs((currentFont?.pointSize ?? 0) - nextFont.pointSize) > 0.5
        context.coordinator.updateBindings(
            text: $text,
            isFocused: $isFocused,
            dynamicHeight: $dynamicHeight
        )
        let maxVisibleLinesChanged = context.coordinator.updateMaxVisibleLines(maxVisibleLines)
        let shouldApplyBindingText = context.coordinator.shouldApplyBindingText(text, to: uiView)
        let textChanged = shouldApplyBindingText && uiView.text != text
        if textChanged {
            uiView.text = text
            context.coordinator.noteAppliedBindingText(text)
        }
        let shouldDeferEditabilityLock = !isEditable && uiView.isEditable && uiView.isFirstResponder
        if !shouldDeferEditabilityLock {
            uiView.isEditable = isEditable
        }
        uiView.isSelectable = true
        if fontChanged {
            uiView.font = nextFont
        }
        uiView.typingAttributes[.font] = nextFont
        uiView.typingAttributes[.foregroundColor] = UIColor.label
        uiView.adjustsFontForContentSizeCategory = true
        uiView.textContainerInset = .zero
        uiView.textContainer.widthTracksTextView = true
        // Preserve internal scrolling without letting composer drags dismiss the keyboard.
        uiView.keyboardDismissMode = .none
        uiView.onPasteImageData = onPasteImageData
        uiView.runtimeState = runtimeState
        uiView.runtimeActions = runtimeActions
        uiView.setContentHuggingPriority(.defaultLow, for: .horizontal)
        context.coordinator.syncFocusIfNeeded(
            for: uiView,
            shouldBeFocused: isFocused,
            isEditable: isEditable
        )
        if shouldDeferEditabilityLock {
            DispatchQueue.main.async { [weak uiView] in
                uiView?.isEditable = false
            }
        }
        context.coordinator.updateHeightIfNeeded(
            for: uiView,
            force: textChanged || fontChanged || maxVisibleLinesChanged
        )
        if maxVisibleLinesChanged {
            context.coordinator.scheduleDeferredHeightUpdate(for: uiView)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            text: $text,
            isFocused: $isFocused,
            dynamicHeight: $dynamicHeight,
            minVisibleLines: minVisibleLines,
            maxVisibleLines: maxVisibleLines
        )
    }

    // Keeps the composer aligned with the app's normal body sizing instead of
    // the smaller ad hoc size that made the input feel visually detached.
    private func composerUIFont() -> UIFont {
        // Read the SwiftUI environment so UIKit gets refreshed when Dynamic Type changes.
        let _ = dynamicTypeSize
        return AppFont.uiFont(size: 15, textStyle: .body)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        private var text: Binding<String>
        private var isFocused: Binding<Bool>
        private var dynamicHeight: Binding<CGFloat>
        private let minVisibleLines: CGFloat
        private var maxVisibleLines: CGFloat
        private var lastFocusBindingValue: Bool
        private var pendingHeightValue: CGFloat?
        private var isHeightCommitScheduled = false
        private var lastHeightMeasurementSignature: HeightMeasurementSignature?
        private var lastIsEditable: Bool
        private var pendingUIKitText: String?
        private var staleBindingTextDuringPendingEdit: String?

        init(
            text: Binding<String>,
            isFocused: Binding<Bool>,
            dynamicHeight: Binding<CGFloat>,
            minVisibleLines: CGFloat,
            maxVisibleLines: CGFloat
        ) {
            self.text = text
            self.isFocused = isFocused
            self.dynamicHeight = dynamicHeight
            self.minVisibleLines = minVisibleLines
            self.maxVisibleLines = maxVisibleLines
            self.lastFocusBindingValue = isFocused.wrappedValue
            self.lastIsEditable = true
        }

        func updateBindings(
            text: Binding<String>,
            isFocused: Binding<Bool>,
            dynamicHeight: Binding<CGFloat>
        ) {
            self.text = text
            self.isFocused = isFocused
            self.dynamicHeight = dynamicHeight
        }

        fileprivate func updateMaxVisibleLines(_ value: CGFloat) -> Bool {
            guard abs(maxVisibleLines - value) > 0.1 else {
                return false
            }
            maxVisibleLines = value
            lastHeightMeasurementSignature = nil
            return true
        }

        func textViewDidChange(_ textView: UITextView) {
            StreamingUIInteractionMonitor.noteComposerKeystroke()
            let newText = textView.text ?? ""
            if text.wrappedValue != newText {
                pendingUIKitText = newText
                staleBindingTextDuringPendingEdit = text.wrappedValue
                let targetText = text
                // Defer the binding write out of UIKit's edit transaction to avoid
                // AttributeGraph cycles.
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    guard self.pendingUIKitText == newText else { return }
                    if targetText.wrappedValue != newText {
                        targetText.wrappedValue = newText
                    }
                    self.pendingUIKitText = nil
                    self.staleBindingTextDuringPendingEdit = nil
                }
            }
            updateHeightIfNeeded(for: textView, force: true)
        }

        // Prevents SwiftUI re-renders from writing an older binding value over
        // fresh UIKit edits while the deferred binding update is still queued.
        fileprivate func shouldApplyBindingText(_ bindingText: String, to textView: UITextView) -> Bool {
            if hasActiveMarkedText(in: textView) {
                return shouldApplyBindingTextDuringPendingEdit(bindingText, textViewText: textView.text ?? "")
            }

            guard
                textView.isFirstResponder,
                let pendingUIKitText,
                textView.text == pendingUIKitText
            else {
                return true
            }

            return shouldApplyBindingTextDuringPendingEdit(bindingText, textViewText: pendingUIKitText)
        }

        fileprivate func noteAppliedBindingText(_ bindingText: String) {
            guard pendingUIKitText != nil else { return }
            if bindingText != pendingUIKitText || bindingText == staleBindingTextDuringPendingEdit {
                pendingUIKitText = nil
                staleBindingTextDuringPendingEdit = nil
            }
        }

        // Allows explicit external updates, such as Send clearing the composer,
        // while still ignoring SwiftUI's stale echo of the previous binding.
        private func shouldApplyBindingTextDuringPendingEdit(_ bindingText: String, textViewText: String) -> Bool {
            guard let pendingUIKitText else {
                return bindingText == textViewText
            }

            if bindingText == pendingUIKitText {
                return true
            }
            if bindingText == staleBindingTextDuringPendingEdit {
                return false
            }

            self.pendingUIKitText = nil
            self.staleBindingTextDuringPendingEdit = nil
            return true
        }

        // iOS keeps predictive/autocorrect composition in marked text; external
        // writes during that window can duplicate characters or move the caret.
        private func hasActiveMarkedText(in textView: UITextView) -> Bool {
            guard let markedRange = textView.markedTextRange else {
                return false
            }
            return !markedRange.isEmpty
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            // UIKit can send focus callbacks while SwiftUI is updating the representable.
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.isFocused.wrappedValue else { return }
                self.isFocused.wrappedValue = true
            }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            // Defer binding writes out of UIKit's edit transaction to avoid AttributeGraph cycles.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.isFocused.wrappedValue else { return }
                self.isFocused.wrappedValue = false
            }
        }

        fileprivate func updateHeightIfNeeded(for textView: UITextView, force: Bool = false) {
            let signature = heightMeasurementSignature(for: textView)
            guard force || signature != lastHeightMeasurementSignature else {
                return
            }
            lastHeightMeasurementSignature = signature
            updateHeight(for: textView)
        }

        fileprivate func scheduleDeferredHeightUpdate(for textView: UITextView) {
            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self, let textView else { return }
                self.updateHeightIfNeeded(for: textView, force: true)
            }
        }

        private func updateHeight(for textView: UITextView) {
            textView.layoutIfNeeded()
            if let textLayoutManager = textView.textLayoutManager {
                textLayoutManager.ensureLayout(for: textLayoutManager.documentRange)
            }
            let lineHeight = (textView.font ?? UIFont.preferredFont(forTextStyle: .body)).lineHeight
            let targetWidth = max(textView.bounds.width, textView.textContainer.size.width, 1)
            let fitSize = CGSize(width: targetWidth, height: .greatestFiniteMagnitude)
            let viewportPadding = (textView as? TurnComposerPasteInterceptingTextView)?
                .viewportPaddingBeyondLineHeight(targetWidth: targetWidth) ?? 0
            let minHeight = ceil(lineHeight * minVisibleLines + viewportPadding)
            let maxHeight = ceil(lineHeight * maxVisibleLines + viewportPadding)
            var measured = textView.sizeThatFits(fitSize).height
            let shouldScroll = measured > maxHeight + 0.5
            if textView.isScrollEnabled != shouldScroll {
                textView.isScrollEnabled = shouldScroll
                textView.alwaysBounceVertical = shouldScroll
                textView.showsVerticalScrollIndicator = shouldScroll
                textView.invalidateIntrinsicContentSize()
                measured = textView.sizeThatFits(fitSize).height
            }
            let clamped = min(max(measured, minHeight), maxHeight)
            normalizeViewport(in: textView, shouldScroll: shouldScroll)

            if abs(dynamicHeight.wrappedValue - clamped) > 0.5 {
                scheduleHeightCommit(clamped)
            }

            keepCaretVisible(in: textView)
        }

        // Avoids recalculating UITextView layout when only the streaming transcript invalidated SwiftUI.
        private func heightMeasurementSignature(for textView: UITextView) -> HeightMeasurementSignature {
            let font = textView.font ?? UIFont.preferredFont(forTextStyle: .body)
            let width = max(textView.bounds.width, textView.textContainer.size.width, 1)
            return HeightMeasurementSignature(
                textHash: textView.text.hashValue,
                widthBucket: Int((width * 2).rounded()),
                lineHeightBucket: Int((font.lineHeight * 10).rounded()),
                isScrollEnabled: textView.isScrollEnabled
            )
        }

        // Coalesces repeated text-layout height writes so SwiftUI sees at most one
        // composer-height update per run-loop turn instead of several per frame.
        private func scheduleHeightCommit(_ height: CGFloat) {
            pendingHeightValue = height
            guard !isHeightCommitScheduled else { return }

            isHeightCommitScheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.isHeightCommitScheduled = false

                guard let pendingHeight = self.pendingHeightValue else { return }
                self.pendingHeightValue = nil

                if abs(self.dynamicHeight.wrappedValue - pendingHeight) > 0.5 {
                    self.dynamicHeight.wrappedValue = pendingHeight
                }
            }
        }

        // Keeps the newest typed line visible once the composer switches from growing to internal scrolling.
        private func keepCaretVisible(in textView: UITextView) {
            guard textView.isScrollEnabled else { return }
            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self, let textView else { return }
                textView.layoutIfNeeded()
                guard let selectionEnd = textView.selectedTextRange?.end else { return }
                let caretRect = textView.caretRect(for: selectionEnd).insetBy(dx: 0, dy: -8)
                textView.scrollRectToVisible(caretRect, animated: false)
                self.alignVisibleTopToLineBoundary(in: textView)
            }
        }

        // Keeps the internal scroll viewport from stopping between line boxes, which clips the first visible line.
        private func alignVisibleTopToLineBoundary(in textView: UITextView) {
            let lineHeight = (textView.font ?? UIFont.preferredFont(forTextStyle: .body)).lineHeight
            guard lineHeight > 0 else { return }

            let adjustedInset = textView.adjustedContentInset
            let minY = -adjustedInset.top
            let maxY = max(minY, textView.contentSize.height - textView.bounds.height + adjustedInset.bottom)
            let lineOrigin = minY + textView.textContainerInset.top
            let currentY = textView.contentOffset.y
            let snappedY = lineOrigin + ((currentY - lineOrigin) / lineHeight).rounded() * lineHeight
            let clampedY = min(max(snappedY, minY), maxY)

            guard abs(currentY - clampedY) > 0.5 else { return }
            textView.setContentOffset(CGPoint(x: textView.contentOffset.x, y: clampedY), animated: false)
        }

        // Resets/clamps the text viewport after Return inserts can nudge UITextView
        // into a stale offset even when the full composer content still fits.
        private func normalizeViewport(in textView: UITextView, shouldScroll: Bool) {
            let adjustedInset = textView.adjustedContentInset
            let minOffset = CGPoint(x: -adjustedInset.left, y: -adjustedInset.top)

            guard shouldScroll else {
                guard
                    abs(textView.contentOffset.x - minOffset.x) > 0.5
                        || abs(textView.contentOffset.y - minOffset.y) > 0.5
                else {
                    return
                }
                textView.setContentOffset(minOffset, animated: false)
                return
            }

            let maxYOffset = max(
                minOffset.y,
                textView.contentSize.height - textView.bounds.height + adjustedInset.bottom
            )
            let clampedOffset = CGPoint(
                x: minOffset.x,
                y: min(max(textView.contentOffset.y, minOffset.y), maxYOffset)
            )

            guard
                abs(textView.contentOffset.x - clampedOffset.x) > 0.5
                    || abs(textView.contentOffset.y - clampedOffset.y) > 0.5
            else {
                return
            }
            textView.setContentOffset(clampedOffset, animated: false)
        }

        fileprivate func syncFocusIfNeeded(
            for textView: UITextView,
            shouldBeFocused: Bool,
            isEditable: Bool
        ) {
            let focusBindingDidChange = shouldBeFocused != lastFocusBindingValue
            let editabilityDidChange = isEditable != lastIsEditable
            lastFocusBindingValue = shouldBeFocused
            lastIsEditable = isEditable

            // Only drive focus changes when the binding or editability actually flipped.
            // Reacting on every updateUIView when the value is merely "still true"
            // causes a becomeFirstResponder → didBeginEditing → binding write →
            // updateUIView → becomeFirstResponder loop that drops the keyboard.
            guard focusBindingDidChange || editabilityDidChange else { return }

            if shouldBeFocused && isEditable {
                guard !textView.isFirstResponder else { return }
                DispatchQueue.main.async {
                    textView.becomeFirstResponder()
                }
            } else if !shouldBeFocused || !isEditable {
                guard textView.isFirstResponder else { return }
                DispatchQueue.main.async { [weak textView] in
                    textView?.resignFirstResponder()
                }
            }
        }
    }

    private struct HeightMeasurementSignature: Equatable {
        let textHash: Int
        let widthBucket: Int
        let lineHeightBucket: Int
        let isScrollEnabled: Bool
    }
}
