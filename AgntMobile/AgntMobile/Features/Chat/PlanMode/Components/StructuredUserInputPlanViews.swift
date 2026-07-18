// FILE: StructuredUserInputPlanViews.swift
// Purpose: Structured input card, accessory, and question sheet for plan mode.
// Layer: View Component

import SwiftUI

struct StructuredUserInputCard: View {
    @Environment(CodexService.self) private var codex

    let request: CodexStructuredUserInputRequest
    let isInteractionLocked: Bool
    let secondaryActionTitle: String?
    let onSecondaryAction: (() -> Void)?

    @State private var isSubmitting = false
    @State private var hasSubmittedResponse = false

    init(
        request: CodexStructuredUserInputRequest,
        isInteractionLocked: Bool = false,
        secondaryActionTitle: String? = nil,
        onSecondaryAction: (() -> Void)? = nil
    ) {
        self.request = request
        self.isInteractionLocked = isInteractionLocked
        self.secondaryActionTitle = secondaryActionTitle
        self.onSecondaryAction = onSecondaryAction
    }

    var body: some View {
        StructuredUserInputCardView(
            questions: request.questions,
            isSubmitting: isSubmitting,
            hasSubmittedResponse: hasSubmittedResponse,
            isInteractionLocked: isInteractionLocked,
            onSelectOption: { _, _ in },
            secondaryActionTitle: secondaryActionTitle,
            onSecondaryAction: onSecondaryAction,
            onSubmit: { answers in
                submitAnswers(answers)
            }
        )
    }

    private func submitAnswers(_ answersByQuestionID: [String: [String]]) {
        guard answersByQuestionID.count == request.questions.count else {
            return
        }

        isSubmitting = true
        hasSubmittedResponse = true
        Task { @MainActor in
            do {
                try await codex.respondToStructuredUserInput(
                    requestID: request.requestID,
                    answersByQuestionID: answersByQuestionID
                )
                isSubmitting = false
            } catch {
                isSubmitting = false
                hasSubmittedResponse = false
                codex.lastErrorMessage = codex.userFacingTurnErrorMessageForFooter(from: error)
            }
        }
    }
}

struct StructuredUserInputAccessory: View {
    let message: CodexMessage
    let onTap: () -> Void

    private var questionCount: Int {
        message.structuredUserInputRequest?.questions.count ?? 0
    }

    var body: some View {
        Button(action: onTap) {
            PlanModeCardContainer(title: "Input needed", showsProgress: false) {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(questionCount == 1 ? "Codex needs one answer" : "Codex needs \(questionCount) answers")
                            .font(AppFont.subheadline(weight: .medium))
                            .foregroundStyle(.primary)

                        Text("Open the prompt to review the plan and respond.")
                            .font(AppFont.caption())
                            .foregroundStyle(.secondary)
                    }

                    Spacer(minLength: 0)

                    Image(systemName: "chevron.up.circle.fill")
                        .font(AppFont.system(size: 20, weight: .semibold))
                        .foregroundStyle(Color(.plan))
                }
            }
        }
        .buttonStyle(.plain)
    }
}

struct StructuredUserInputSheet: View {
    @Environment(\.dismiss) private var dismiss

    let requestMessage: CodexMessage
    let planMessage: CodexMessage?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let planMessage {
                        PlanSystemCard(message: planMessage)
                    }

                    if let request = requestMessage.structuredUserInputRequest {
                        StructuredUserInputCard(request: request)
                    }
                }
                .padding(16)
            }
            .background(Color(.systemBackground))
            .navigationTitle("Questions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
