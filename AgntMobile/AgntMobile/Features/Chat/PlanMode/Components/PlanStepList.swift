// FILE: PlanStepList.swift
// Purpose: Plan step list and status row rendering.
// Layer: View Component

import SwiftUI

struct PlanStepList: View {
    let steps: [CodexPlanStep]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(steps) { step in
                PlanStepRow(step: step)
            }
        }
    }
}

private struct PlanStepRow: View {
    let step: CodexPlanStep

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: statusSymbol)
                .font(AppFont.system(size: 12, weight: .semibold))
                .foregroundStyle(statusColor)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 4) {
                Text(step.step)
                    .font(AppFont.body())
                    .foregroundStyle(.primary)

                Text(statusLabel)
                    .font(AppFont.caption2(weight: .medium))
                    .foregroundStyle(statusColor)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(statusColor.opacity(0.12), in: Capsule())
            }
        }
    }

    private var statusLabel: String {
        switch step.status {
        case .pending:
            return "Pending"
        case .inProgress:
            return "In progress"
        case .completed:
            return "Completed"
        }
    }

    private var statusSymbol: String {
        switch step.status {
        case .pending:
            return "circle"
        case .inProgress:
            return "clock"
        case .completed:
            return "checkmark.circle.fill"
        }
    }

    private var statusColor: Color {
        switch step.status {
        case .pending:
            return .secondary
        case .inProgress:
            return .orange
        case .completed:
            return .green
        }
    }
}
