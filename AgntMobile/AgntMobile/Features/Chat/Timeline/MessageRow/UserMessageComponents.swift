// FILE: UserMessageComponents.swift
// Purpose: SwiftUI helper views for user-authored timeline message bubbles.
// Layer: View Components

import SwiftUI
import UIKit

struct UserAttachmentThumbnailView: View {
    let attachment: CodexImageAttachment
    private let side = TurnAttachmentThumbnailMetrics.side
    private let cornerRadius = TurnAttachmentThumbnailMetrics.cornerRadius

    var body: some View {
        if let image = thumbnailUIImage {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: side, height: side)
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .stroke(Color(.separator), lineWidth: 1)
                )
        } else {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color(.secondarySystemFill))
                .frame(width: side, height: side)
                .overlay(
                    Image(systemName: "photo")
                        .foregroundStyle(.secondary)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .stroke(Color(.separator), lineWidth: 1)
                )
        }
    }

    private var thumbnailUIImage: UIImage? {
        guard !attachment.thumbnailBase64JPEG.isEmpty,
              let data = Data(base64Encoded: attachment.thumbnailBase64JPEG) else {
            return nil
        }
        return UIImage(data: data)
    }
}

struct UserAttachmentStrip: View {
    let attachments: [CodexImageAttachment]
    let onTap: (CodexImageAttachment) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            ForEach(attachments) { attachment in
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    onTap(attachment)
                } label: {
                    UserAttachmentThumbnailView(attachment: attachment)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

struct UserBubbleTextBlock<Content: View>: View {
    private static var collapseLineLimit: Int { 10 }
    private static var collapseCharacterThreshold: Int { 360 }
    private static var collapseNewlineThreshold: Int { 8 }

    let contentIdentity: String
    let rawText: String
    var contentResetKey: String? = nil
    var collapsesWithLineLimit: Bool = true
    @ViewBuilder let content: (_ isCollapsed: Bool) -> Content

    @State private var isExpanded = false

    private var canCollapse: Bool {
        var characterCount = 0
        var newlineCount = 0
        for character in rawText {
            characterCount += 1
            if characterCount > Self.collapseCharacterThreshold {
                return true
            }
            if character == "\n" {
                newlineCount += 1
                if newlineCount >= Self.collapseNewlineThreshold {
                    return true
                }
            }
        }
        return false
    }

    private var collapseResetKey: String {
        "\(contentIdentity)|\(contentResetKey ?? TurnTextCacheKey.stableFingerprint(for: rawText))"
    }

    private static var collapsedContentMaxHeight: CGFloat {
        UIFont.preferredFont(forTextStyle: .body).lineHeight * CGFloat(collapseLineLimit)
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            collapsibleContent

            if canCollapse {
                Button(isExpanded ? "Show less" : "Show more") {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        isExpanded.toggle()
                    }
                }
                .buttonStyle(.plain)
                .font(AppFont.footnote())
                .foregroundStyle(.secondary)
            }
        }
        .onChange(of: collapseResetKey) { _, _ in
            isExpanded = false
        }
    }

    @ViewBuilder
    private var collapsibleContent: some View {
        let isCollapsed = canCollapse && !isExpanded
        if collapsesWithLineLimit {
            content(isCollapsed)
                .lineLimit(isCollapsed ? Self.collapseLineLimit : nil)
        } else {
            content(isCollapsed)
                .frame(maxHeight: isCollapsed ? Self.collapsedContentMaxHeight : nil, alignment: .top)
                .clipped()
                .allowsHitTesting(!isCollapsed)
        }
    }
}
