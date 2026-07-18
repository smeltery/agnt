// FILE: PlanCards.swift
// Purpose: Inline plan card, inferred questionnaire card, and proposed-plan implementation action.
// Layer: View Component

import SwiftUI

struct PlanSystemCard: View {
    @Environment(CodexService.self) private var codex

    let message: CodexMessage

    private var threadMessages: [CodexMessage] {
        codex.messages(for: message.threadId)
    }

    private var bodyText: String {
        let trimmed = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let placeholders: Set<String> = ["Planning..."]
        guard !trimmed.isEmpty, !placeholders.contains(trimmed) else {
            return ""
        }
        return trimmed
    }

    private var explanationText: String? {
        let trimmed = message.planState?.explanation?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else {
            return nil
        }
        guard trimmed != bodyText else {
            return nil
        }
        return trimmed
    }

    private var rawInferredQuestionnaire: InferredPlanQuestionnaire? {
        resolvedInferredPlanQuestionnaire(
            bodyText: bodyText,
            message: message,
            threadMessages: threadMessages,
            shouldRecoverFallback: codex.allowsInferredPlanQuestionnaireFallback(for: message.threadId),
            windowEndOrderIndex: nextPlanMessageOrderIndex,
            parse: InferredPlanQuestionnaireParser.parse
        )
    }

    private var inferredQuestionnaire: InferredPlanQuestionnaire? {
        rawInferredQuestionnaire
    }

    private var nextPlanMessageOrderIndex: Int? {
        threadMessages
            .filter { candidate in
                candidate.id != message.id
                    && candidate.role == .system
                    && candidate.kind == .plan
                    && candidate.orderIndex > message.orderIndex
            }
            .map(\.orderIndex)
            .min()
    }
    var body: some View {
        PlanModeCardContainer(title: "Plan", showsProgress: message.isStreaming) {
            if let inferredQuestionnaire {
                if let introText = inferredQuestionnaire.introText {
                    MarkdownTextView(text: introText, profile: .assistantProse)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let explanationText {
                    MarkdownTextView(text: explanationText, profile: .assistantProse)
                }

                InferredPlanQuestionnaireCard(
                    message: message,
                    questionnaire: inferredQuestionnaire
                )

                if let outroText = inferredQuestionnaire.outroText {
                    Text(outroText)
                        .font(AppFont.footnote())
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if !bodyText.isEmpty {
                MarkdownTextView(text: bodyText, profile: .assistantProse)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let explanationText {
                MarkdownTextView(text: explanationText, profile: .assistantProse)
            }

            if inferredQuestionnaire == nil,
               let explanationText,
               !bodyText.isEmpty,
               explanationText != bodyText {
                Text(explanationText)
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
            }

            if let steps = message.planState?.steps, !steps.isEmpty {
                PlanStepList(steps: steps)
            }
        }
    }
}

private struct NormalizedQuestionSignature: Hashable {
    let question: String
    let options: [String]

    nonisolated init(_ question: CodexStructuredUserInputQuestion) {
        self.question = question.question
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        self.options = question.options.map {
            $0.label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }
    }
}

func resolvedInferredPlanQuestionnaire(
    bodyText: String,
    message: CodexMessage,
    threadMessages: [CodexMessage],
    shouldRecoverFallback: Bool = true,
    windowEndOrderIndex: Int? = nil,
    parse: (String) -> InferredPlanQuestionnaire?
) -> InferredPlanQuestionnaire? {
    // Prefer native requestUserInput when it exists, but still recover clearly
    // structured plain-text fallbacks if the runtime regresses inside the same thread.
    guard shouldRecoverFallback,
          let questionnaire = parse(bodyText),
          !hasMatchingNativeStructuredPrompt(
            for: questionnaire,
            message: message,
            threadMessages: threadMessages,
            windowEndOrderIndex: windowEndOrderIndex
          ) else {
        return nil
    }

    return questionnaire
}

private func hasMatchingNativeStructuredPrompt(
    for questionnaire: InferredPlanQuestionnaire,
    message: CodexMessage,
    threadMessages: [CodexMessage],
    windowEndOrderIndex: Int?
) -> Bool {
    let inferredSignature = normalizedQuestionSignature(for: questionnaire.questions)

    return threadMessages.contains { candidate in
        guard candidate.kind == .userInputPrompt,
              let request = candidate.structuredUserInputRequest else {
            return false
        }

        if let messageTurnId = message.turnId, let candidateTurnId = candidate.turnId {
            return messageTurnId == candidateTurnId
        }

        guard candidate.orderIndex >= message.orderIndex else {
            return false
        }
        if let windowEndOrderIndex,
           candidate.orderIndex >= windowEndOrderIndex {
            return false
        }

        return normalizedQuestionSignature(for: request.questions) == inferredSignature
    }
}

private func normalizedQuestionSignature(
    for questions: [CodexStructuredUserInputQuestion]
) -> [NormalizedQuestionSignature] {
    questions.map(NormalizedQuestionSignature.init)
}

struct InferredPlanQuestionnaireCard: View {
    @Environment(CodexService.self) private var codex

    let message: CodexMessage
    let questionnaire: InferredPlanQuestionnaire

    @State private var isSubmitting = false
    @State private var hasSubmittedResponse = false

    var body: some View {
        StructuredUserInputCardView(
            questions: questionnaire.questions,
            isSubmitting: isSubmitting,
            hasSubmittedResponse: hasSubmittedResponse,
            isInteractionLocked: false,
            onSelectOption: { _, _ in },
            secondaryActionTitle: nil,
            onSecondaryAction: nil,
            onSubmit: { answers in
                submitAnswers(answers)
            }
        )
    }

    private func submitAnswers(_ answersByQuestionID: [String: [String]]) {
        guard answersByQuestionID.count == questionnaire.questions.count else {
            return
        }

        isSubmitting = true
        hasSubmittedResponse = true
        Task { @MainActor in
            do {
                try await codex.submitInferredPlanQuestionnaireResponse(
                    threadId: message.threadId,
                    questions: questionnaire.questions,
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

struct ProposedPlanResultCard: View {
    @Environment(CodexService.self) private var codex

    let threadId: String
    let proposedPlan: CodexProposedPlan
    let isStreaming: Bool
    let canImplement: Bool

    @State private var isImplementing = false
    @State private var hasStartedImplementation = false

    private var canRenderImplementationAction: Bool {
        canImplement && !isStreaming && !proposedPlan.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var isImplementationLocked: Bool {
        isImplementing || hasStartedImplementation
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Proposed plan")
                .font(AppFont.subheadline(weight: .semibold))
                .foregroundStyle(.primary)

            MarkdownTextView(text: proposedPlan.body, profile: .assistantProse)
                .fixedSize(horizontal: false, vertical: true)

            if canRenderImplementationAction {
                Button {
                    implementPlan()
                } label: {
                    HStack(spacing: 8) {
                        if isImplementationLocked {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "arrow.right.circle.fill")
                                .font(AppFont.system(size: 14, weight: .semibold))
                        }
                        Text(isImplementationLocked ? "Starting implementation…" : "Implement plan")
                            .font(AppFont.subheadline(weight: .semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(isImplementationLocked)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color(.secondarySystemBackground))
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(Color(.separator).opacity(0.12))
                )
        )
    }

    private func implementPlan() {
        guard canRenderImplementationAction, !isImplementationLocked else {
            return
        }

        isImplementing = true
        Task { @MainActor in
            do {
                try await codex.implementProposedPlan(
                    threadId: threadId,
                    proposedPlan: proposedPlan
                )
                isImplementing = false
                hasStartedImplementation = true
            } catch {
                isImplementing = false
                hasStartedImplementation = false
                codex.lastErrorMessage = codex.userFacingTurnErrorMessageForFooter(from: error)
            }
        }
    }
}
