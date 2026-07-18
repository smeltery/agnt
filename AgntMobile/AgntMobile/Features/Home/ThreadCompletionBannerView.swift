// FILE: ThreadCompletionBannerView.swift
// Purpose: Shows reusable in-app toast banners, including thread-completion notifications.
// Layer: View
// Exports: InAppToastBannerView, ThreadCompletionBannerView, SystemNoticeBannerView
// Depends on: SwiftUI, CodexThreadCompletionBanner

import SwiftUI

struct InAppToastBannerView<LeadingIcon: View>: View {
    let title: String
    let subtitle: String?
    let detailLines: [String]
    let accessibilityHint: String?
    let isDismissable: Bool
    let onTap: (() -> Void)?
    let onDismiss: (() -> Void)?
    let leadingIcon: () -> LeadingIcon

    private let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)

    init(
        title: String,
        subtitle: String?,
        detailLines: [String] = [],
        accessibilityHint: String?,
        isDismissable: Bool,
        onTap: (() -> Void)?,
        onDismiss: (() -> Void)?,
        @ViewBuilder leadingIcon: @escaping () -> LeadingIcon
    ) {
        self.title = title
        self.subtitle = subtitle
        self.detailLines = detailLines
        self.accessibilityHint = accessibilityHint
        self.isDismissable = isDismissable
        self.onTap = onTap
        self.onDismiss = onDismiss
        self.leadingIcon = leadingIcon
    }

    var body: some View {
        HStack(spacing: 12) {
            leadingIcon()
                .frame(width: 28, height: 28)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(AppFont.subheadline(weight: .semibold))
                    .lineLimit(1)

                if let subtitle {
                    Text(subtitle)
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                if !detailLines.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(detailLines, id: \.self) { line in
                            Text(line)
                                .font(AppFont.caption())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    .padding(.top, subtitle == nil ? 0 : 2)
                }
            }

            Spacer(minLength: 8)

            if isDismissable, let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss notification")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .adaptiveGlass(.regular, in: shape)
        .overlay(
            shape.stroke(Color.primary.opacity(0.08), lineWidth: 1)
        )
        .contentShape(shape)
        .onTapGesture {
            onTap?()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(accessibilityHint ?? "")
    }

    private var accessibilityLabel: String {
        let detail = detailLines.joined(separator: " ")
        if let subtitle {
            return [title, subtitle, detail]
                .filter { !$0.isEmpty }
                .joined(separator: ". ")
        }
        return [title, detail]
            .filter { !$0.isEmpty }
            .joined(separator: ". ")
    }
}

struct ThreadCompletionBannerView: View {
    let banner: CodexThreadCompletionBanner
    let onTap: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        InAppToastBannerView(
            title: banner.title,
            subtitle: "Answer ready in another chat",
            accessibilityHint: "Opens the completed chat.",
            isDismissable: true,
            onTap: onTap,
            onDismiss: onDismiss
        ) {
            Circle()
                .fill(Color.green)
                .frame(width: 10, height: 10)
                .overlay(
                    Circle()
                        .stroke(Color(.systemBackground), lineWidth: 1)
                )
        }
    }
}

struct SystemNoticeBannerView: View {
    let notice: CodexSystemNotice
    let onDismiss: () -> Void

    var body: some View {
        InAppToastBannerView(
            title: notice.title ?? fallbackTitle,
            subtitle: notice.title == nil ? nil : notice.message,
            detailLines: detailLines,
            accessibilityHint: nil,
            isDismissable: true,
            onTap: nil,
            onDismiss: onDismiss
        ) {
            Image(systemName: iconName)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(iconColor)
                .frame(width: 28, height: 28)
                .background(iconColor.opacity(0.14), in: Circle())
        }
    }

    private var fallbackTitle: String {
        switch notice.severity {
        case .info:
            return "Notice"
        case .warn:
            return "Warning"
        case .error:
            return "Error"
        }
    }

    private var detailLines: [String] {
        var lines: [String] = []
        if notice.title == nil, let message = notice.message {
            lines.append(message)
        }
        if let provider = notice.provider {
            lines.append(provider)
        }
        return lines
    }

    private var iconName: String {
        switch notice.severity {
        case .info:
            return "info"
        case .warn:
            return "exclamationmark.triangle.fill"
        case .error:
            return "xmark.octagon.fill"
        }
    }

    private var iconColor: Color {
        switch notice.severity {
        case .info:
            return .blue
        case .warn:
            return .orange
        case .error:
            return .red
        }
    }
}
