// FILE: AgntLiveActivity.swift
// Purpose: Live Activity / Dynamic Island presentation for an in-flight agnt
//          turn. Shows the conversation title and a coarse running/done/stopped
//          status on the Lock Screen banner, the Dynamic Island (expanded,
//          compact, minimal), and the Always-On display.
// Layer: Widget Extension
//
// Driven entirely by the app via ActivityKit local updates (see
// LiveActivityCoordinator in the app target). No network, no push, no
// provider-specific copy.

import ActivityKit
import SwiftUI
import WidgetKit

struct AgntLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgntActivityAttributes.self) { context in
            AgntLiveActivityLockScreenView(
                attributes: context.attributes,
                state: context.state
            )
            .activityBackgroundTint(Color.black.opacity(0.35))
            .activitySystemActionForegroundColor(.primary)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    AgntPhaseGlyph(phase: context.state.phase)
                        .frame(width: 28, height: 28)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.attributes.startedAt, style: .timer)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: 56, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.threadTitle)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.state.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                AgntPhaseGlyph(phase: context.state.phase)
                    .frame(width: 18, height: 18)
            } compactTrailing: {
                if context.state.phase == .running {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .scaleEffect(0.7)
                } else {
                    AgntPhaseStatusIcon(phase: context.state.phase)
                }
            } minimal: {
                if context.state.phase == .running {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .scaleEffect(0.7)
                } else {
                    AgntPhaseStatusIcon(phase: context.state.phase)
                }
            }
            .widgetURL(URL(string: "agnt://home"))
            .keylineTint(.accentColor)
        }
    }
}

// MARK: - Lock Screen / banner

private struct AgntLiveActivityLockScreenView: View {
    let attributes: AgntActivityAttributes
    let state: AgntActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 12) {
            AgntPhaseGlyph(phase: state.phase)
                .frame(width: 36, height: 36)

            VStack(alignment: .leading, spacing: 2) {
                Text(attributes.threadTitle)
                    .font(.headline)
                    .lineLimit(1)
                Text(state.detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            if state.phase == .running {
                Text(attributes.startedAt, style: .timer)
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 64, alignment: .trailing)
            } else {
                AgntPhaseStatusIcon(phase: state.phase)
                    .font(.title3)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

// MARK: - Shared phase visuals

private struct AgntPhaseGlyph: View {
    let phase: AgntActivityAttributes.ContentState.Phase

    var body: some View {
        Image("agnt_symbol_medium")
            .resizable()
            .renderingMode(.template)
            .scaledToFit()
            .foregroundStyle(tint)
            .widgetAccentable()
    }

    private var tint: Color {
        switch phase {
        case .running: return .accentColor
        case .completed: return .green
        case .failed: return .orange
        }
    }
}

private struct AgntPhaseStatusIcon: View {
    let phase: AgntActivityAttributes.ContentState.Phase

    var body: some View {
        switch phase {
        case .running:
            Image(systemName: "ellipsis")
                .foregroundStyle(.secondary)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed:
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.orange)
        }
    }
}

#if DEBUG
extension AgntActivityAttributes {
    fileprivate static var preview: AgntActivityAttributes {
        AgntActivityAttributes(threadTitle: "Refactor bridge router", startedAt: Date())
    }
}

extension AgntActivityAttributes.ContentState {
    fileprivate static var running: Self {
        .init(phase: .running, detail: "Working…", updatedAt: Date())
    }
    fileprivate static var done: Self {
        .init(phase: .completed, detail: "Done", updatedAt: Date())
    }
}

#Preview("Lock Screen", as: .content, using: AgntActivityAttributes.preview) {
    AgntLiveActivity()
} contentStates: {
    AgntActivityAttributes.ContentState.running
    AgntActivityAttributes.ContentState.done
}
#endif
