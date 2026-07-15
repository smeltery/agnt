// FILE: StructuredUserInputCardView+Previews.swift
// Purpose: Preview scenarios for the structured plan-mode question card.
// Layer: Preview support
// Exports: SwiftUI previews
// Depends on: SwiftUI, StructuredUserInputCardView

import SwiftUI

#Preview("Multiple choice") {
    ScrollView {
        StructuredUserInputCardView(
            questions: [
                CodexStructuredUserInputQuestion(
                    id: "q1",
                    header: "Architecture",
                    question: "How should the new networking layer be structured?",
                    isOther: false,
                    isSecret: false,
                    options: [
                        CodexStructuredUserInputOption(label: "Async/Await", description: "Modern Swift concurrency with structured tasks"),
                        CodexStructuredUserInputOption(label: "Combine", description: "Reactive streams using Apple's Combine framework"),
                        CodexStructuredUserInputOption(label: "Callbacks", description: "Traditional completion handler pattern"),
                    ]
                )
            ],
            isSubmitting: false,
            hasSubmittedResponse: false,
            isInteractionLocked: false,
            onSelectOption: { _, _ in },
            secondaryActionTitle: nil,
            onSecondaryAction: nil,
            onSubmit: { _ in }
        )
        .padding(.horizontal, 16)
    }
    .background(Color(.systemBackground))
}

#Preview("Freeform text") {
    ScrollView {
        StructuredUserInputCardView(
            questions: [
                CodexStructuredUserInputQuestion(
                    id: "q1",
                    header: "Naming",
                    question: "What should the new module be called?",
                    isOther: false,
                    isSecret: false,
                    options: []
                )
            ],
            isSubmitting: false,
            hasSubmittedResponse: false,
            isInteractionLocked: false,
            onSelectOption: { _, _ in },
            secondaryActionTitle: nil,
            onSecondaryAction: nil,
            onSubmit: { _ in }
        )
        .padding(.horizontal, 16)
    }
    .background(Color(.systemBackground))
}

#Preview("Secret input") {
    ScrollView {
        StructuredUserInputCardView(
            questions: [
                CodexStructuredUserInputQuestion(
                    id: "q1",
                    header: "Credentials",
                    question: "Enter the API key for the staging environment:",
                    isOther: false,
                    isSecret: true,
                    options: []
                )
            ],
            isSubmitting: false,
            hasSubmittedResponse: false,
            isInteractionLocked: false,
            onSelectOption: { _, _ in },
            secondaryActionTitle: nil,
            onSecondaryAction: nil,
            onSubmit: { _ in }
        )
        .padding(.horizontal, 16)
    }
    .background(Color(.systemBackground))
}

#Preview("Options + Other") {
    ScrollView {
        StructuredUserInputCardView(
            questions: [
                CodexStructuredUserInputQuestion(
                    id: "q1",
                    header: "Deployment",
                    question: "Where should this service be deployed?",
                    isOther: true,
                    isSecret: false,
                    options: [
                        CodexStructuredUserInputOption(label: "AWS", description: "Amazon Web Services EC2/ECS"),
                        CodexStructuredUserInputOption(label: "GCP", description: "Google Cloud Run"),
                        CodexStructuredUserInputOption(label: "Self-hosted", description: "On-premise VPS"),
                    ]
                )
            ],
            isSubmitting: false,
            hasSubmittedResponse: false,
            isInteractionLocked: false,
            onSelectOption: { _, _ in },
            secondaryActionTitle: nil,
            onSecondaryAction: nil,
            onSubmit: { _ in }
        )
        .padding(.horizontal, 16)
    }
    .background(Color(.systemBackground))
}

#Preview("Multi-question form") {
    ScrollView {
        StructuredUserInputCardView(
            questions: [
                CodexStructuredUserInputQuestion(
                    id: "q1",
                    header: "Scope",
                    question: "Should the refactor include the legacy API endpoints?",
                    isOther: false,
                    isSecret: false,
                    options: [
                        CodexStructuredUserInputOption(label: "Yes", description: "Migrate everything at once"),
                        CodexStructuredUserInputOption(label: "No", description: "Only new endpoints for now"),
                    ]
                ),
                CodexStructuredUserInputQuestion(
                    id: "q2",
                    header: "Testing",
                    question: "What's the minimum test coverage target?",
                    isOther: false,
                    isSecret: false,
                    options: []
                ),
                CodexStructuredUserInputQuestion(
                    id: "q3",
                    header: "Timeline",
                    question: "When should the migration be completed?",
                    isOther: true,
                    isSecret: false,
                    options: [
                        CodexStructuredUserInputOption(label: "This sprint", description: "2-week delivery window"),
                        CodexStructuredUserInputOption(label: "Next quarter", description: "Phased rollout with buffer"),
                    ]
                ),
            ],
            isSubmitting: false,
            hasSubmittedResponse: false,
            isInteractionLocked: false,
            onSelectOption: { _, _ in },
            secondaryActionTitle: nil,
            onSecondaryAction: nil,
            onSubmit: { _ in }
        )
        .padding(.horizontal, 16)
    }
    .background(Color(.systemBackground))
}

#Preview("Submitting state") {
    ScrollView {
        StructuredUserInputCardView(
            questions: [
                CodexStructuredUserInputQuestion(
                    id: "q1",
                    header: "",
                    question: "Should I proceed with the migration?",
                    isOther: false,
                    isSecret: false,
                    options: [
                        CodexStructuredUserInputOption(label: "Yes", description: ""),
                        CodexStructuredUserInputOption(label: "No", description: ""),
                    ]
                )
            ],
            isSubmitting: true,
            hasSubmittedResponse: false,
            isInteractionLocked: false,
            onSelectOption: { _, _ in },
            secondaryActionTitle: nil,
            onSecondaryAction: nil,
            onSubmit: { _ in }
        )
        .padding(.horizontal, 16)
    }
    .background(Color(.systemBackground))
}
