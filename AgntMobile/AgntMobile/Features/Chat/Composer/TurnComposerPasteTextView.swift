// FILE: TurnComposerPasteTextView.swift
// Purpose: Custom UITextView for composer paste-image intake, runtime edit menu controls, and viewport clamping.
// Layer: View Component
// Exports: TurnComposerPasteInterceptingTextView
// Depends on: UIKit, TurnComposerRuntimeMenuBuilder

import UIKit

private struct ViewportPaddingSignature: Equatable {
    let widthBucket: Int
    let fontName: String
    let fontPointSizeBucket: Int
    let topInsetBucket: Int
    let bottomInsetBucket: Int
    let lineFragmentPaddingBucket: Int
}

private struct ViewportPaddingCacheEntry {
    let signature: ViewportPaddingSignature
    let value: CGFloat
}

// Internal because UIViewRepresentable protocol methods expose the type.
final class TurnComposerPasteInterceptingTextView: UITextView {
    var onPasteImageData: (([Data]) -> Void)?
    var runtimeState: TurnComposerRuntimeState?
    var runtimeActions: TurnComposerRuntimeActions?
    private var cachedViewportPadding: ViewportPaddingCacheEntry?

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
    }

    // Prevent horizontal expansion when isScrollEnabled is toggled to false.
    // Without this, SwiftUI uses the full text width as the ideal size.
    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: super.intrinsicContentSize.height)
    }

    // TextKit needs a small viewport allowance beyond raw font line height; measuring it avoids clipped final lines.
    func viewportPaddingBeyondLineHeight(targetWidth: CGFloat) -> CGFloat {
        let signature = ViewportPaddingSignature(
            widthBucket: Int((targetWidth * 2).rounded()),
            fontName: font?.fontName ?? "",
            fontPointSizeBucket: Int(((font?.pointSize ?? 0) * 10).rounded()),
            topInsetBucket: Int((textContainerInset.top * 2).rounded()),
            bottomInsetBucket: Int((textContainerInset.bottom * 2).rounded()),
            lineFragmentPaddingBucket: Int((textContainer.lineFragmentPadding * 2).rounded())
        )
        if let cachedViewportPadding, cachedViewportPadding.signature == signature {
            return cachedViewportPadding.value
        }

        let measuringView = UITextView(frame: CGRect(x: 0, y: 0, width: targetWidth, height: 1))
        measuringView.font = font
        measuringView.textContainerInset = textContainerInset
        measuringView.textContainer.lineFragmentPadding = textContainer.lineFragmentPadding
        measuringView.textContainer.widthTracksTextView = true
        measuringView.text = " "
        let measured = measuringView.sizeThatFits(
            CGSize(width: targetWidth, height: .greatestFiniteMagnitude)
        ).height
        let lineHeight = (font ?? UIFont.preferredFont(forTextStyle: .body)).lineHeight
        let value = max(0, measured - lineHeight)
        cachedViewportPadding = ViewportPaddingCacheEntry(signature: signature, value: value)
        return value
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        guard !isScrollEnabled else { return }

        let pinnedOffset = CGPoint(
            x: -adjustedContentInset.left,
            y: -adjustedContentInset.top
        )
        guard
            abs(contentOffset.x - pinnedOffset.x) > 0.5
                || abs(contentOffset.y - pinnedOffset.y) > 0.5
        else {
            return
        }
        contentOffset = pinnedOffset
    }

    // Adds the shared runtime controls directly into the text edit menu.
    override func buildMenu(with builder: any UIMenuBuilder) {
        super.buildMenu(with: builder)

        guard let runtimeState, let runtimeActions else {
            return
        }

        guard let runtimeMenu = TurnComposerRuntimeMenuBuilder(
            runtimeState: runtimeState,
            runtimeActions: runtimeActions
        ).makeRuntimeMenu() else {
            return
        }

        builder.insertChild(runtimeMenu, atEndOfMenu: .standardEdit)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(UIResponderStandardEditActions.paste(_:)) {
            let pb = UIPasteboard.general
            if pb.hasImages { return true }
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        let pasteboard = UIPasteboard.general
        let imageDataItems = imageDataFromPasteboard(pasteboard)
        if !imageDataItems.isEmpty {
            onPasteImageData?(imageDataItems)
            if pasteboard.hasStrings {
                super.paste(sender)
            }
            return
        }
        super.paste(sender)
    }

    private static let maxIntakeDimension: CGFloat = 1600
    private static let intakeCompressionQuality: CGFloat = 0.8

    private func imageDataFromPasteboard(_ pasteboard: UIPasteboard) -> [Data] {
        var imageDataItems: [Data] = []

        if let images = pasteboard.images, !images.isEmpty {
            imageDataItems = images.compactMap { Self.downscaledJPEGData(from: $0) }
        } else if let image = pasteboard.image {
            if let data = Self.downscaledJPEGData(from: image) {
                imageDataItems = [data]
            }
        } else {
            let fallbackTypeIDs = [
                "public.heic",
                "public.jpeg",
                "public.png",
                "public.tiff",
                "com.compuserve.gif"
            ]

            for typeID in fallbackTypeIDs {
                if let data = pasteboard.data(forPasteboardType: typeID), !data.isEmpty {
                    imageDataItems.append(data)
                }
            }
        }

        return imageDataItems
    }

    /// Downscales a UIImage to `maxIntakeDimension` before encoding to JPEG,
    /// so full-resolution data never enters the attachment pipeline.
    private static func downscaledJPEGData(from image: UIImage) -> Data? {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }

        let longestSide = max(size.width, size.height)
        let scale = min(1, maxIntakeDimension / longestSide)

        if scale < 1 {
            let target = CGSize(width: floor(size.width * scale), height: floor(size.height * scale))
            let format = UIGraphicsImageRendererFormat.default()
            format.scale = 1
            let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
                image.draw(in: CGRect(origin: .zero, size: target))
            }
            return resized.jpegData(compressionQuality: intakeCompressionQuality)
        }

        return image.jpegData(compressionQuality: intakeCompressionQuality)
    }
}
