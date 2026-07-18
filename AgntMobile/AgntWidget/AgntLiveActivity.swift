// FILE: AgntLiveActivity.swift
// Purpose: Live Activity / Dynamic Island presentation for off-screen agnt
//          conversations. Shows aggregate running/review counts plus a compact
//          list of conversations that need attention.
// Layer: Widget Extension

import ActivityKit
import SwiftUI
import WidgetKit

struct AgntLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgntActivityAttributes.self) { context in
            AgntLiveActivityLockScreenView(state: context.state, isStale: context.isStale)
                .activityBackgroundTint(Color.black.opacity(0.35))
                .activitySystemActionForegroundColor(.primary)
                .widgetURL(context.state.primaryThreadURL ?? URL(string: "agnt://home"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    AgntCountView(
                        value: context.state.runningConversations.count,
                        title: context.isStale ? "Paused" : "Running",
                        tint: context.isStale ? .secondary : .accentColor
                    )
                }
                DynamicIslandExpandedRegion(.trailing) {
                    AgntCountView(
                        value: context.state.reviewCount,
                        title: "Review",
                        tint: context.state.failedConversations.isEmpty ? .green : .orange
                    )
                }
                DynamicIslandExpandedRegion(.bottom) {
                    AgntConversationList(state: context.state, isStale: context.isStale, compact: true)
                }
            } compactLeading: {
                Image("agnt_symbol_medium")
                    .resizable()
                    .renderingMode(.template)
                    .scaledToFit()
                    .foregroundStyle(context.isStale ? Color.secondary : Color.accentColor)
                    .padding(.vertical, 2)
            } compactTrailing: {
                Text(compactStatusText(for: context.state, isStale: context.isStale))
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
            } minimal: {
                Image("agnt_symbol_medium")
                    .resizable()
                    .renderingMode(.template)
                    .scaledToFit()
                    .foregroundStyle(context.isStale ? Color.secondary : Color.accentColor)
                    .padding(.vertical, 2)
            }
            .keylineTint(context.isStale ? .gray : .accentColor)
            .widgetURL(context.state.primaryThreadURL ?? URL(string: "agnt://home"))
        }
    }

    private func compactStatusText(
        for state: AgntActivityAttributes.ContentState,
        isStale: Bool
    ) -> String {
        if !state.runningConversations.isEmpty {
            return isStale ? "…" : "\(state.runningConversations.count)"
        }
        if !state.failedConversations.isEmpty {
            return "!"
        }
        return "\(state.completedConversations.count)"
    }
}

private struct AgntLiveActivityLockScreenView: View {
    let state: AgntActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image("agnt_symbol_medium")
                    .resizable()
                    .renderingMode(.template)
                    .scaledToFit()
                    .foregroundStyle(isStale ? Color.secondary : Color.accentColor)
                    .frame(width: 24, height: 24)

                VStack(alignment: .leading, spacing: 1) {
                    Text("agnt")
                        .font(.subheadline.weight(.semibold))
                    Text(headerSubtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 0)
            }

            AgntConversationList(state: state, isStale: isStale, compact: false)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var headerSubtitle: String {
        let running = state.runningConversations.count
        let completed = state.completedConversations.count
        let failed = state.failedConversations.count
        let runningLabel = isStale ? "paused" : "running"
        if failed > 0, running > 0 {
            return "\(running) \(runningLabel), \(failed) failed"
        }
        if failed > 0 {
            return failed == 1 ? "1 failed" : "\(failed) failed"
        }
        if running > 0, completed > 0 {
            return "\(running) \(runningLabel), \(completed) ready"
        }
        if running > 0 {
            return running == 1 ? "1 \(runningLabel)" : "\(running) \(runningLabel)"
        }
        return completed == 1 ? "1 ready" : "\(completed) ready"
    }
}

private struct AgntConversationList: View {
    let state: AgntActivityAttributes.ContentState
    let isStale: Bool
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 4 : 6) {
            ForEach(displayRows) { conversation in
                HStack(spacing: 8) {
                    Image(systemName: symbolName(for: conversation))
                        .foregroundStyle(tint(for: conversation))
                        .frame(width: 14)

                    Text(conversation.title)
                        .font(compact ? .caption2 : .caption.weight(.semibold))
                        .lineLimit(1)

                    Spacer(minLength: 0)

                    Text(detail(for: conversation))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
    }

    private var displayRows: [AgntActivityConversation] {
        Array((state.runningConversations + state.failedConversations + state.completedConversations).prefix(3))
    }

    private func detail(for conversation: AgntActivityConversation) -> String {
        if isStale, conversation.phase == .running {
            return "Paused"
        }
        return conversation.detail
    }

    private func symbolName(for conversation: AgntActivityConversation) -> String {
        switch conversation.phase {
        case .running:
            return isStale ? "pause.circle.fill" : "ellipsis.circle.fill"
        case .completed:
            return "checkmark.circle.fill"
        case .failed:
            return "exclamationmark.circle.fill"
        }
    }

    private func tint(for conversation: AgntActivityConversation) -> Color {
        switch conversation.phase {
        case .running:
            return isStale ? .secondary : .accentColor
        case .completed:
            return .green
        case .failed:
            return .orange
        }
    }
}

private struct AgntCountView: View {
    let value: Int
    let title: String
    let tint: Color

    var body: some View {
        VStack(spacing: 1) {
            Text("\(value)")
                .font(.headline.monospacedDigit())
                .foregroundStyle(tint)
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

private extension AgntActivityAttributes.ContentState {
    var reviewCount: Int {
        completedConversations.count + failedConversations.count
    }
}

#if DEBUG
extension AgntActivityAttributes {
    fileprivate static var preview: AgntActivityAttributes {
        AgntActivityAttributes(title: "agnt", startedAt: Date())
    }
}

extension AgntActivityAttributes.ContentState {
    fileprivate static var running: Self {
        .init(
            runningConversations: [
                AgntActivityConversation(
                    id: "thread-1",
                    title: "Refactor bridge router",
                    detail: "Working...",
                    phase: .running,
                    runningStartedAt: Date()
                )
            ],
            completedConversations: [],
            failedConversations: [],
            updatedAt: Date()
        )
    }

    fileprivate static var review: Self {
        .init(
            runningConversations: [],
            completedConversations: [
                AgntActivityConversation(
                    id: "thread-2",
                    title: "Update docs",
                    detail: "Ready",
                    phase: .completed,
                    runningStartedAt: nil
                )
            ],
            failedConversations: [],
            updatedAt: Date()
        )
    }
}

#Preview("Lock Screen", as: .content, using: AgntActivityAttributes.preview) {
    AgntLiveActivity()
} contentStates: {
    AgntActivityAttributes.ContentState.running
    AgntActivityAttributes.ContentState.review
}
#endif
