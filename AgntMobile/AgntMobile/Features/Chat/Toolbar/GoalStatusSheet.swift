// FILE: GoalStatusSheet.swift
// Purpose: Presents thread goal create, edit, pause, resume, and clear controls.
// Layer: View Component
// Exports: GoalStatusSheet
// Depends on: SwiftUI, CodexService, CodexThreadGoal

import SwiftUI

struct GoalStatusSheet: View {
    let threadId: String
    let initialObjectiveDraft: String?
    var onObjectiveSubmitted: ((String) -> Void)? = nil

    @Environment(CodexService.self) private var codex

    private enum EditorMode {
        case create
        case edit
    }

    @State private var isEditing = false
    @State private var editorMode: EditorMode = .create
    @State private var objectiveDraft = ""
    @State private var tokenBudgetDraft = ""
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var isShowingClearConfirmation = false
    @State private var isShowingReplaceConfirmation = false
    @State private var hasLoadedRemoteGoal = false

    private var goal: CodexThreadGoal? {
        codex.goalByThreadID[threadId]
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    if let errorMessage {
                        errorCard(errorMessage)
                    }

                    if isEditing || goal == nil {
                        editorCard
                    } else if let goal {
                        summaryCard(goal)
                        actionsCard(goal)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
            .navigationTitle("Goal")
            .navigationBarTitleDisplayMode(.inline)
            .adaptiveNavigationBar()
        }
        .presentationDetents([.medium, .large])
        .task { await loadGoalOnce() }
        .confirmationDialog("Clear this goal?", isPresented: $isShowingClearConfirmation, titleVisibility: .visible) {
            Button("Clear Goal", role: .destructive) {
                perform { try await codex.clearThreadGoal(threadId: threadId) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("agnt stops pursuing the objective and forgets its progress accounting.")
        }
        .confirmationDialog("Replace the current goal?", isPresented: $isShowingReplaceConfirmation, titleVisibility: .visible) {
            Button("Replace Goal", role: .destructive) {
                perform { try await submitDraft() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Replacing an unfinished goal starts progress over for the new objective.")
        }
    }

    private func summaryCard(_ goal: CodexThreadGoal) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: goal.status.symbolName)
                    .foregroundStyle(statusColor(goal.status))
                Text(goal.status.displayLabel)
                    .font(AppFont.subheadline(weight: .semibold))
                    .foregroundStyle(statusColor(goal.status))
                Spacer()
                Text(goal.usageSummary)
                    .font(AppFont.mono(.caption))
                    .foregroundStyle(.secondary)
            }

            Text(goal.objective)
                .font(AppFont.body())
                .frame(maxWidth: .infinity, alignment: .leading)

            if let tokenBudget = goal.tokenBudget {
                Text("Budget \(CodexThreadGoal.formatTokenCount(tokenBudget)) tokens, \(CodexThreadGoal.formatTokenCount(goal.remainingTokens ?? 0)) remaining")
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func actionsCard(_ goal: CodexThreadGoal) -> some View {
        VStack(spacing: 10) {
            if goal.status == .active {
                sheetAction("Pause Goal", systemImage: "pause.circle") {
                    perform { try await codex.setThreadGoal(threadId: threadId, status: .paused) }
                }
            }

            if goal.status.isResumable {
                sheetAction("Resume Goal", systemImage: "play.circle") {
                    perform { try await codex.setThreadGoal(threadId: threadId, status: .active) }
                }
            }

            sheetAction(goal.status == .complete ? "New Goal" : "Edit Goal", systemImage: "pencil") {
                objectiveDraft = goal.status == .complete ? "" : goal.objective
                tokenBudgetDraft = goal.status == .complete ? "" : goal.tokenBudget.map(String.init) ?? ""
                editorMode = goal.status == .complete ? .create : .edit
                isEditing = true
            }

            sheetAction("Clear Goal", systemImage: "trash", role: .destructive) {
                isShowingClearConfirmation = true
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity)
        .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var editorCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(editorMode == .edit ? "Edit Goal" : "New Goal")
                .font(AppFont.subheadline(weight: .semibold))

            TextEditor(text: $objectiveDraft)
                .frame(minHeight: 120)
                .padding(8)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color(.secondarySystemBackground))
                )

            TextField("Token budget (optional)", text: $tokenBudgetDraft)
                .keyboardType(.numberPad)
                .textFieldStyle(.roundedBorder)

            HStack(spacing: 10) {
                if goal != nil {
                    Button("Cancel") { isEditing = false }
                        .buttonStyle(.bordered)
                        .disabled(isWorking)
                }

                Button {
                    submitWithConfirmationIfNeeded()
                } label: {
                    if isWorking {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Text(editorMode == .edit ? "Save Goal" : "Start Goal")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(trimmedObjective.isEmpty || isWorking)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(AppFont.footnote())
            .foregroundStyle(.red)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.red.opacity(0.1))
            )
    }

    private func sheetAction(
        _ title: String,
        systemImage: String,
        role: ButtonRole? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(role: role, action: action) {
            Label(title, systemImage: systemImage)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .disabled(isWorking)
    }

    private var trimmedObjective: String {
        objectiveDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func submitWithConfirmationIfNeeded() {
        guard !trimmedObjective.isEmpty else { return }
        if editorMode == .create, let goal, goal.status != .complete {
            isShowingReplaceConfirmation = true
            return
        }
        perform { try await submitDraft() }
    }

    private func submitDraft() async throws {
        try await codex.setThreadGoal(
            threadId: threadId,
            objective: trimmedObjective,
            status: editorMode == .create ? .active : nil,
            tokenBudget: try budgetUpdate()
        )
        onObjectiveSubmitted?(trimmedObjective)
        isEditing = false
    }

    private func budgetUpdate() throws -> CodexThreadGoalBudgetUpdate {
        let trimmedBudget = tokenBudgetDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBudget.isEmpty else {
            return goal?.tokenBudget == nil ? .keep : .clear
        }
        guard let budget = Int(trimmedBudget), budget > 0 else {
            throw CodexThreadGoalError.invalidBudget
        }
        return .set(budget)
    }

    private func perform(_ operation: @escaping () async throws -> Void) {
        guard !isWorking else { return }
        isWorking = true
        errorMessage = nil

        Task { @MainActor in
            defer { isWorking = false }
            do {
                try await operation()
            } catch {
                errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func loadGoalOnce() async {
        guard !hasLoadedRemoteGoal else { return }
        hasLoadedRemoteGoal = true

        do {
            _ = try await codex.readThreadGoal(threadId: threadId)
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }

        if let initialObjectiveDraft, !initialObjectiveDraft.isEmpty {
            objectiveDraft = initialObjectiveDraft
            editorMode = .create
            isEditing = true
        }
    }

    private func statusColor(_ status: CodexThreadGoalStatus) -> Color {
        switch status {
        case .active:
            return .accentColor
        case .paused:
            return .secondary
        case .blocked, .usageLimited, .budgetLimited:
            return .orange
        case .complete:
            return .green
        }
    }
}
