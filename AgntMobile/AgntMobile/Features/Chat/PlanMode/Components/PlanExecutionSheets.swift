// FILE: PlanExecutionSheets.swift
// Purpose: Plan execution accessory and active-plan sheet.
// Layer: View Component

import SwiftUI

struct PlanExecutionAccessory: View {
    let message: CodexMessage
    let onTap: () -> Void

    // Maps the live message into a previewable snapshot so the visual card can stay isolated.
    private var snapshot: PlanAccessorySnapshot {
        PlanAccessorySnapshot(message: message)
    }

    var body: some View {
        PlanAccessoryCard(snapshot: snapshot, onTap: onTap)
    }
}

struct PlanExecutionSheet: View {
    @Environment(\.dismiss) private var dismiss

    let message: CodexMessage

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    PlanSystemCard(message: message)
                }
                .padding(16)
            }
            .background(Color(.systemBackground))
            .navigationTitle("Active plan")
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
