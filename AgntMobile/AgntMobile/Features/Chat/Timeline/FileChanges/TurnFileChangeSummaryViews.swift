// FILE: TurnFileChangeSummaryViews.swift
// Purpose: Renders timeline file-change recap rows, expandable summaries, and review finding cards.
// Layer: View Components
// Exports: File-change timeline summary views
// Depends on: SwiftUI, TurnFileChangeSummaryParser, TurnDiffRenderer

import SwiftUI

// Keeps live file-change deltas as lightweight status rows while a turn is still streaming.
struct FileChangeInlineActionRow: View {
    let entry: TurnFileChangeSummaryEntry
    var showActionLabel: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if showActionLabel {
                Text(entry.action?.rawValue ?? "Edited")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary.opacity(0.6))
            }

            HStack(spacing: 6) {
                Text(entry.compactPath)
                    .foregroundStyle(Color.blue)
                    .lineLimit(1)
                    .truncationMode(.middle)

                DiffCountsLabel(additions: entry.additions, deletions: entry.deletions)
                    .font(AppFont.subheadline())
            }
            .font(AppFont.body())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

enum FileChangeSummaryPreview {
    static let previewEntryLimit = 3

    static func visibleEntries(
        from entries: [TurnFileChangeSummaryEntry],
        showsAllEntries: Bool
    ) -> ArraySlice<TurnFileChangeSummaryEntry> {
        showsAllEntries ? entries[...] : entries.prefix(previewEntryLimit)
    }

    static func hiddenEntryCount(
        totalEntryCount: Int,
        showsAllEntries: Bool
    ) -> Int {
        showsAllEntries ? 0 : max(0, totalEntryCount - previewEntryLimit)
    }
}

// Renders turn-end file edits as one compact recap instead of chat-like rows.
struct FileChangeSummaryBox: View {
    let entries: [TurnFileChangeSummaryEntry]
    let fallbackText: String
    let messageID: String

    // Default to expanded so the recap stays informative without an extra tap;
    // collapse remains available for long lists or visual decluttering.
    @State private var isExpanded: Bool = true
    @State private var showsAllEntries: Bool = false
    @State private var selectedEntry: TurnFileChangeSummaryEntry?

    private var canCollapse: Bool {
        !entries.isEmpty || !fallbackText.isEmpty
    }

    private var visibleEntries: ArraySlice<TurnFileChangeSummaryEntry> {
        FileChangeSummaryPreview.visibleEntries(
            from: entries,
            showsAllEntries: showsAllEntries
        )
    }

    private var hiddenEntryCount: Int {
        FileChangeSummaryPreview.hiddenEntryCount(
            totalEntryCount: entries.count,
            showsAllEntries: showsAllEntries
        )
    }

    private var hasEntryOverflow: Bool {
        entries.count > FileChangeSummaryPreview.previewEntryLimit
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            if isExpanded {
                if !entries.isEmpty {
                    Divider()

                    ForEach(Array(visibleEntries.enumerated()), id: \.element.id) { index, entry in
                        let isLastEntry = index == visibleEntries.count - 1

                        Button {
                            selectedEntry = entry
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(entry.compactPath)
                                    .font(AppFont.subheadline())
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)

                                Spacer(minLength: 8)

                                if entry.additions > 0 || entry.deletions > 0 {
                                    DiffCountsLabel(additions: entry.additions, deletions: entry.deletions)
                                        .font(AppFont.subheadline())
                                }
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 9)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        if !isLastEntry || hiddenEntryCount > 0 {
                            Divider()
                                .padding(.leading, 12)
                        }
                    }

                    if hiddenEntryCount > 0 || showsAllEntries && hasEntryOverflow {
                        Button {
                            withAnimation(.easeInOut(duration: 0.18)) {
                                showsAllEntries.toggle()
                            }
                        } label: {
                            HStack(spacing: 6) {
                                Text(showsAllEntries ? "Show less" : "Show more")
                                    .font(AppFont.subheadline(weight: .medium))

                                Image(systemName: "chevron.down")
                                    .font(AppFont.system(size: 10, weight: .semibold))
                                    .rotationEffect(.degrees(showsAllEntries ? 180 : 0))
                                    .accessibilityHidden(true)
                            }
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 9)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(
                            showsAllEntries
                                ? "Show fewer file changes"
                                : "Show \(hiddenEntryCount) more file changes"
                        )
                    }
                } else if !fallbackText.isEmpty {
                    Text(fallbackText)
                        .font(AppFont.footnote())
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 10)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color(.secondarySystemBackground),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(.separator).opacity(0.4), lineWidth: 0.5)
        }
        .padding(2)
        .sheet(item: $selectedEntry) { entry in
            TurnDiffSheet(
                title: entry.compactPath,
                entries: [entry],
                bodyText: fallbackText,
                messageID: messageID,
                restrictToPath: entry.path
            )
        }
    }

    @ViewBuilder
    private var header: some View {
        let content = HStack(spacing: 6) {
            Image(systemName: "pencil.line")
                .font(AppFont.footnote(weight: .semibold))
                .foregroundStyle(.secondary)

            Text(title)
                .font(AppFont.footnote(weight: .semibold))
                .foregroundStyle(.secondary)

            Spacer(minLength: 8)

            if canCollapse {
                Image(systemName: "chevron.down")
                    .font(AppFont.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isExpanded ? 0 : -90))
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, isExpanded && !entries.isEmpty ? 8 : 10)
        .contentShape(Rectangle())

        if canCollapse {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                content
            }
            .buttonStyle(.plain)
            .accessibilityLabel(title)
            .accessibilityHint(isExpanded ? "Collapse list" : "Expand list")
            .accessibilityAddTraits(.isButton)
        } else {
            content
        }
    }

    private var title: String {
        let count = entries.count
        if count == 0 {
            return "Files modified"
        }
        if count == 1 {
            return "1 file modified"
        }
        return "\(count) files modified"
    }
}

struct CodeCommentFindingCard: View {
    let finding: CodeCommentDirectiveFinding

    private var priorityLevel: Int {
        min(max(finding.priority ?? 3, 0), 3)
    }

    private var priorityColor: Color {
        switch priorityLevel {
        case 0:
            return .red
        case 1:
            return .orange
        case 2:
            return .yellow
        default:
            return .blue
        }
    }

    private var fileName: String {
        finding.file.pathDisplayName
    }

    private var lineLabel: String? {
        guard let startLine = finding.startLine else { return nil }
        if let endLine = finding.endLine, endLine != startLine {
            return "L\(startLine)-\(endLine)"
        }
        return "L\(startLine)"
    }

    private var confidenceLabel: String? {
        guard let confidence = finding.confidence else { return nil }
        let clamped = min(max(confidence, 0), 1)
        return "\(Int((clamped * 100).rounded()))%"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("P\(priorityLevel)")
                    .font(AppFont.mono(.caption))
                    .foregroundStyle(priorityColor)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(priorityColor.opacity(0.12), in: Capsule())

                Text(finding.title)
                    .font(AppFont.body(weight: .semibold))
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)

                Spacer(minLength: 0)
            }

            Text(finding.body)
                .font(AppFont.body())
                .foregroundStyle(.primary.opacity(0.92))
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                Text(fileName)
                    .font(AppFont.mono(.caption))
                    .foregroundStyle(.primary.opacity(0.78))
                    .lineLimit(1)

                if let lineLabel {
                    Text(lineLabel)
                        .font(AppFont.mono(.caption))
                        .foregroundStyle(.secondary)
                }

                if let confidenceLabel {
                    Text(confidenceLabel)
                        .font(AppFont.mono(.caption))
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 0)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(priorityColor.opacity(0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(priorityColor.opacity(0.28), lineWidth: 1)
        )
        .textSelection(.enabled)
    }
}
