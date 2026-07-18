// FILE: PlanAccessoryPreviews.swift
// Purpose: Hosts preview fixtures and preview-only layouts for PlanAccessoryCard.
// Layer: Preview
// Exports: PlanAccessoryPreviewFixtures
// Depends on: SwiftUI, CodexMessage, CodexCollaboration

import SwiftUI

enum PlanAccessoryPreviewFixtures {
    static let threadID = "thread_preview_plan_accessory"

    static let activeMessage = CodexMessage(
        threadId: threadID,
        role: .system,
        kind: .plan,
        text: "Preparing the rollout in small, safe steps so the response stays visible while work is happening.",
        isStreaming: true,
        planState: CodexPlanState(
            explanation: "The assistant is organizing the work before execution.",
            steps: [
                CodexPlanStep(step: "Inspect the current conversation layout and top overlay behavior", status: .completed),
                CodexPlanStep(step: "Move the active plan out of the timeline overlay and into a compact accessory", status: .inProgress),
                CodexPlanStep(step: "Open the full task list in a sheet when the compact row is tapped", status: .pending),
            ]
        )
    )

    static let pendingMessage = CodexMessage(
        threadId: threadID,
        role: .system,
        kind: .plan,
        text: "Planning...",
        planState: CodexPlanState(
            explanation: "The task has been broken down and is waiting to begin.",
            steps: [
                CodexPlanStep(step: "Confirm the runtime contract for plan updates", status: .pending),
                CodexPlanStep(step: "Split the accessory into a reusable component", status: .pending),
                CodexPlanStep(step: "Add focused previews for visual iteration", status: .pending),
            ]
        )
    )

    static let completedMessage = CodexMessage(
        threadId: threadID,
        role: .system,
        kind: .plan,
        text: "All plan tasks are done.",
        planState: CodexPlanState(
            explanation: "This is how the compact row looks once every step is complete.",
            steps: [
                CodexPlanStep(step: "Review the old overlay behavior", status: .completed),
                CodexPlanStep(step: "Replace it with a compact accessory above the composer", status: .completed),
                CodexPlanStep(step: "Present the full plan inside a sheet", status: .completed),
            ]
        )
    )
}

private struct PlanAccessoryPreviewGallery: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                previewSection(
                    title: "Live plan",
                    snapshot: PlanAccessorySnapshot(message: PlanAccessoryPreviewFixtures.activeMessage)
                )

                previewSection(
                    title: "Queued plan",
                    snapshot: PlanAccessorySnapshot(message: PlanAccessoryPreviewFixtures.pendingMessage)
                )

                previewSection(
                    title: "Completed plan",
                    snapshot: PlanAccessorySnapshot(message: PlanAccessoryPreviewFixtures.completedMessage)
                )
            }
            .padding(16)
        }
        .background(Color(.systemGroupedBackground))
    }

    private func previewSection(title: String, snapshot: PlanAccessorySnapshot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(AppFont.caption(weight: .medium))
                .foregroundStyle(.secondary)

            PlanAccessoryCard(snapshot: snapshot) { }
        }
    }
}

private struct PlanAccessoryCardOnlyPreview: View {
    let snapshot: PlanAccessorySnapshot

    var body: some View {
        VStack {
            PlanAccessoryCard(snapshot: snapshot) { }
                .padding(16)
            Spacer(minLength: 0)
        }
        .background(Color(.systemGroupedBackground))
    }
}

private struct PlanAccessoryInContextPreview: View {
    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        previewUserBubble("Could you improve the compact plan row so it feels clearer while a task is running?")
                        previewAssistantBubble(
                            """
                            I split the plan row into a dedicated component so the UI can be previewed in isolation.
                            The card below now mirrors the live state without needing the full timeline to render.
                            """
                        )
                        Color.clear
                            .frame(height: 180)
                    }
                    .padding(16)
                }

                VStack(spacing: 10) {
                    PlanAccessoryCard(snapshot: PlanAccessorySnapshot(message: PlanAccessoryPreviewFixtures.activeMessage)) { }
                        .padding(.horizontal, 12)

                    previewComposer
                        .padding(.horizontal, 12)
                        .padding(.bottom, 12)
                }
                .background(
                    LinearGradient(
                        colors: [
                            Color(.systemGroupedBackground).opacity(0),
                            Color(.systemGroupedBackground).opacity(0.92),
                            Color(.systemGroupedBackground),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .ignoresSafeArea(edges: .bottom)
                )
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Plan Accessory")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func previewUserBubble(_ text: String) -> some View {
        HStack {
            Spacer(minLength: 48)

            Text(text)
                .font(AppFont.body())
                .foregroundStyle(.primary)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
    }

    private func previewAssistantBubble(_ text: String) -> some View {
        HStack {
            Text(text)
                .font(AppFont.body())
                .foregroundStyle(.primary)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            Spacer(minLength: 48)
        }
    }

    private var previewComposer: some View {
        HStack(spacing: 12) {
            Image(systemName: "plus")
                .font(AppFont.system(size: 14, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 32)
                .background(Color(.secondarySystemBackground), in: Circle())

            Text("Ask Codex to continue...")
                .font(AppFont.body())
                .foregroundStyle(.secondary)

            Spacer(minLength: 0)

            Image(systemName: "arrow.up.circle.fill")
                .font(AppFont.system(size: 24, weight: .semibold))
                .foregroundStyle(Color(.plan))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 14)
        .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
    }
}

#Preview("Plan Accessory Gallery") {
    PlanAccessoryPreviewGallery()
}

#Preview("Plan Card Only - Active") {
    PlanAccessoryCardOnlyPreview(
        snapshot: PlanAccessorySnapshot(message: PlanAccessoryPreviewFixtures.activeMessage)
    )
}

#Preview("Plan Card Only - Pending") {
    PlanAccessoryCardOnlyPreview(
        snapshot: PlanAccessorySnapshot(message: PlanAccessoryPreviewFixtures.pendingMessage)
    )
}

#Preview("Plan Card Only - Completed") {
    PlanAccessoryCardOnlyPreview(
        snapshot: PlanAccessorySnapshot(message: PlanAccessoryPreviewFixtures.completedMessage)
    )
}

#Preview("Plan Accessory In Context") {
    PlanAccessoryInContextPreview()
}
