// FILE: PlanAccessoryCard.swift
// Purpose: Hosts the compact active-plan accessory as a standalone, previewable view.
// Layer: View Component
// Exports: PlanAccessoryCard, PlanAccessorySnapshot
// Depends on: SwiftUI, CodexMessage, CodexCollaboration

import SwiftUI

enum PlanAccessoryStatus: Equatable {
    case pending
    case inProgress
    case completed

    var label: String {
        switch self {
        case .pending:
            return "Pending"
        case .inProgress:
            return "In progress"
        case .completed:
            return "Completed"
        }
    }

    var symbolName: String {
        switch self {
        case .pending:
            return "list.bullet.clipboard"
        case .inProgress:
            return "clock.fill"
        case .completed:
            return "checkmark.circle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .pending:
            return Color(.plan)
        case .inProgress:
            return .orange
        case .completed:
            return .green
        }
    }
}

struct PlanAccessorySnapshot: Equatable {
    let title: String
    let summary: String
    let status: PlanAccessoryStatus
    let completedStepCount: Int
    let totalStepCount: Int
    let isStreaming: Bool
    let stepStatuses: [CodexPlanStepStatus]

    init(
        title: String = "Plan",
        summary: String,
        status: PlanAccessoryStatus,
        completedStepCount: Int,
        totalStepCount: Int,
        isStreaming: Bool = false,
        stepStatuses: [CodexPlanStepStatus] = []
    ) {
        self.title = title
        self.summary = summary
        self.status = status
        self.completedStepCount = completedStepCount
        self.totalStepCount = totalStepCount
        self.isStreaming = isStreaming
        self.stepStatuses = stepStatuses
    }

    init(message: CodexMessage) {
        let steps = message.planState?.steps ?? []
        let completedStepCount = steps.filter { $0.status == .completed }.count
        let totalStepCount = steps.count
        let status = Self.resolveStatus(from: steps, completedStepCount: completedStepCount)

        self.init(
            summary: Self.resolveSummary(from: message, steps: steps),
            status: status,
            completedStepCount: completedStepCount,
            totalStepCount: totalStepCount,
            isStreaming: message.isStreaming,
            stepStatuses: steps.map(\.status)
        )
    }

    var progressText: String? {
        guard totalStepCount > 0 else { return nil }
        return "\(completedStepCount)/\(totalStepCount)"
    }

    var progressDescription: String {
        guard totalStepCount > 0 else { return status.label }
        return "\(completedStepCount) of \(totalStepCount) complete"
    }

    private static func resolveStatus(
        from steps: [CodexPlanStep],
        completedStepCount: Int
    ) -> PlanAccessoryStatus {
        if steps.contains(where: { $0.status == .inProgress }) {
            return .inProgress
        }
        if !steps.isEmpty, completedStepCount == steps.count {
            return .completed
        }
        return .pending
    }

    private static func resolveSummary(from message: CodexMessage, steps: [CodexPlanStep]) -> String {
        if let highlightedStep = steps.first(where: { $0.status == .inProgress })
            ?? steps.first(where: { $0.status == .pending })
            ?? steps.last {
            return highlightedStep.step
        }

        let explanation = normalizedPlanText(message.planState?.explanation)
        if let explanation {
            return explanation
        }

        let body = normalizedPlanText(message.text)
        return body ?? "Open plan details"
    }

    // Filters placeholder copy so the compact UI only surfaces useful context.
    private static func normalizedPlanText(_ rawValue: String?) -> String? {
        guard let rawValue else { return nil }
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != "Planning..." else {
            return nil
        }
        return trimmed
    }
}

/// Shared glass-backed card used by above-composer accessories (plan, subagent, etc.).
struct GlassAccessoryCard<LeadingMarker: View, Header: View, Summary: View, Trailing: View>: View {
    let onTap: () -> Void
    @ViewBuilder let leadingMarker: () -> LeadingMarker
    @ViewBuilder let header: () -> Header
    @ViewBuilder let summary: () -> Summary
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            onTap()
        } label: {
            HStack(alignment: .center, spacing: 10) {
                leadingMarker()

                VStack(alignment: .leading, spacing: 5) {
                    header()
                    summary()
                }

                Spacer(minLength: 0)

                trailing()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color.clear)
                    .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            )
        }
        .buttonStyle(.plain)
    }
}

struct PlanAccessoryCard: View {
    let snapshot: PlanAccessorySnapshot
    let onTap: () -> Void

    var body: some View {
        GlassAccessoryCard(onTap: onTap) {
            leadingMarker
        } header: {
            headerRow
        } summary: {
            summaryRow
        } trailing: {
            trailingMetric
        }
        .accessibilityLabel("Open active plan")
        .accessibilityValue("\(snapshot.status.label), \(snapshot.progressDescription)")
        .accessibilityHint("Shows the current plan steps in a sheet")
    }

    private var leadingMarker: some View {
        ZStack {
            Circle()
                .fill(snapshot.status.tint.opacity(0.1))
                .frame(width: 22, height: 22)

            Circle()
                .fill(snapshot.status.tint)
                .frame(width: 7, height: 7)
        }
    }

    private var headerRow: some View {
        HStack(alignment: .center, spacing: 6) {
            Text(snapshot.title)
                .font(AppFont.mono(.caption2))
                .foregroundStyle(.secondary)

            Circle()
                .fill(Color(.separator).opacity(0.6))
                .frame(width: 3, height: 3)

            Text(snapshot.status.label)
                .font(AppFont.caption(weight: .regular))
                .foregroundStyle(snapshot.status.tint)

            if !snapshot.stepStatuses.isEmpty {
                stepRail
                    .padding(.leading, 2)
            }

            if snapshot.isStreaming {
                ProgressView()
                    .controlSize(.mini)
                    .scaleEffect(0.8)
                    .padding(.leading, 2)
            }
        }
    }

    private var summaryRow: some View {
        Text(snapshot.summary)
            .font(AppFont.subheadline(weight: .medium))
            .foregroundStyle(.primary)
            .lineLimit(1)
            .multilineTextAlignment(.leading)
    }

    private var trailingMetric: some View {
        VStack(alignment: .trailing, spacing: 1) {
            if let progressText = snapshot.progressText {
                Text(progressText)
                    .font(AppFont.mono(.caption))
                    .foregroundStyle(.primary)
            } else {
                Text(snapshot.status.label)
                    .font(AppFont.caption(weight: .medium))
                    .foregroundStyle(snapshot.status.tint)
            }
        }
        .frame(minWidth: 36, alignment: .trailing)
    }

    private var stepRail: some View {
        HStack(spacing: 3) {
            ForEach(Array(snapshot.stepStatuses.enumerated()), id: \.offset) { _, status in
                Capsule()
                    .fill(stepTint(for: status))
                    .frame(width: 10, height: 3)
            }
        }
        .accessibilityHidden(true)
    }

    private func stepTint(for status: CodexPlanStepStatus) -> Color {
        switch status {
        case .pending:
            return Color(.separator).opacity(0.22)
        case .inProgress:
            return snapshot.status.tint.opacity(0.72)
        case .completed:
            return Color.primary.opacity(0.72)
        }
    }
}

/// Carries the pinned active-plan state from the conversation container down to
/// the composer's carousel row without widening the composer parameter chain.
struct PinnedPlanAccessoryContext {
    let snapshot: PlanAccessorySnapshot
    let onTap: () -> Void
}

private struct PinnedPlanAccessoryKey: EnvironmentKey {
    static let defaultValue: PinnedPlanAccessoryContext? = nil
}

extension EnvironmentValues {
    var pinnedPlanAccessory: PinnedPlanAccessoryContext? {
        get { self[PinnedPlanAccessoryKey.self] }
        set { self[PinnedPlanAccessoryKey.self] = newValue }
    }
}
