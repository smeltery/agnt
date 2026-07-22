// FILE: AutoApprovalReviewRow.swift
// Purpose: Presents automatic approval-review lifecycle rows in the timeline.
// Layer: View Component
// Exports: AutoApprovalReviewRow
// Depends on: SwiftUI, CodexService, CodexAutoApprovalReview

import SwiftUI

struct AutoApprovalReviewRow: View {
    let threadId: String
    let review: CodexAutoApprovalReview
    let actionSummary: String

    @State private var isExpanded = false

    private var presentation: AutoApprovalReviewPresentation {
        AutoApprovalReviewPresentation(status: review.status)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: toggleExpanded) {
                HStack(spacing: 8) {
                    if review.status == .inProgress {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: presentation.iconSystemName)
                            .font(AppFont.system(size: 17, weight: .semibold))
                            .foregroundStyle(presentation.color)
                    }
                    Text("Auto-review · \(presentation.statusLabel)")
                        .font(AppFont.body())
                        .foregroundStyle(.secondary)
                    Image(systemName: "chevron.right")
                        .font(AppFont.system(size: 13, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Auto-review, \(presentation.statusLabel)")
            .accessibilityHint(isExpanded ? "Collapse review details" : "Expand review details")

            if isExpanded {
                AutoApprovalReviewDetails(
                    threadId: threadId,
                    review: review,
                    actionSummary: actionSummary,
                    statusColor: presentation.color
                )
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func toggleExpanded() {
        withAnimation(.easeInOut(duration: 0.18)) {
            isExpanded.toggle()
        }
    }
}

private struct AutoApprovalReviewDetails: View {
    let threadId: String
    let review: CodexAutoApprovalReview
    let actionSummary: String
    let statusColor: Color

    private var riskLabel: String? {
        normalized(review.riskLevel).map { "\($0.capitalized) risk" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(actionSummary)
                .font(AppFont.footnote(weight: .medium))
                .foregroundStyle(.primary)
                .textSelection(.enabled)

            if let riskLabel {
                Text(riskLabel)
                    .font(AppFont.caption())
                    .foregroundStyle(statusColor)
            }

            if let authorization = normalized(review.userAuthorization) {
                Text("Authorization: \(authorization)")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }

            if let rationale = normalized(review.rationale) {
                Text(rationale)
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if review.status == .denied {
                AutoApprovalRetryControl(threadId: threadId, review: review)
            }
        }
        .padding(.leading, 25)
    }

    private func normalized(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        return value
    }
}

private struct AutoApprovalRetryControl: View {
    @Environment(CodexService.self) private var codex

    let threadId: String
    let review: CodexAutoApprovalReview

    @State private var isApprovingRetry = false
    @State private var retryErrorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if review.retryApproved {
                Label("Approval recorded; the retry will still be reviewed", systemImage: "checkmark")
                    .font(AppFont.footnote(weight: .medium))
                    .foregroundStyle(.secondary)
            } else if let retryUnavailableReason = review.retryUnavailableReason {
                Text(retryUnavailableReason)
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
            } else {
                Button(action: approveOneRetry) {
                    HStack(spacing: 7) {
                        if isApprovingRetry {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Text("Approve one retry")
                    }
                    .font(AppFont.footnote(weight: .semibold))
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .tint(.blue)
                .disabled(isApprovingRetry)
            }

            if let retryErrorMessage {
                Text(retryErrorMessage)
                    .font(AppFont.caption())
                    .foregroundStyle(.red)
            }
        }
    }

    private func approveOneRetry() {
        guard !isApprovingRetry else {
            return
        }

        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        isApprovingRetry = true
        retryErrorMessage = nil

        Task { @MainActor in
            defer { isApprovingRetry = false }
            do {
                try await codex.approveAutoApprovalRetry(
                    threadId: threadId,
                    reviewId: review.reviewId
                )
            } catch {
                retryErrorMessage = error.localizedDescription
            }
        }
    }
}

private struct AutoApprovalReviewPresentation {
    let statusLabel: String
    let iconSystemName: String
    let color: Color

    init(status: CodexAutoApprovalReviewStatus) {
        switch status {
        case .inProgress:
            statusLabel = "Reviewing"
            iconSystemName = "shield"
            color = .secondary
        case .approved:
            statusLabel = "Approved"
            iconSystemName = "checkmark.shield.fill"
            color = .green
        case .denied:
            statusLabel = "Denied"
            iconSystemName = "exclamationmark.triangle.fill"
            color = .orange
        case .timedOut:
            statusLabel = "Timed out"
            iconSystemName = "hourglass"
            color = .secondary
        case .aborted:
            statusLabel = "Stopped"
            iconSystemName = "xmark.circle.fill"
            color = .secondary
        case .unknown:
            statusLabel = "Updated"
            iconSystemName = "questionmark.circle"
            color = .secondary
        }
    }
}
