// FILE: SubagentAgentDetailSheet.swift
// Purpose: Presents detail metadata for a subagent timeline row.
// Layer: View Component
// Exports: SubagentAgentDetailSheet
// Depends on: SwiftUI, AppFont, SubagentLabelParser

import SwiftUI

struct SubagentAgentDetailSheet: View {
    let title: String
    let accentColor: Color
    let statusText: String
    let modelTitle: String
    let modelLabel: String?
    let instructionText: String?
    let latestUpdateText: String?
    let onOpen: (() -> Void)?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    statusSection

                    if let modelLabel, !modelLabel.isEmpty {
                        detailSection(title: modelTitle, value: modelLabel, monospace: true)
                    }

                    if let instructionText, !instructionText.isEmpty {
                        detailSection(title: "Instructions", value: instructionText)
                    }

                    if let latestUpdateText, !latestUpdateText.isEmpty {
                        detailSection(title: "Latest update", value: latestUpdateText)
                    }

                    if instructionText == nil, latestUpdateText == nil {
                        Text("No extra details yet.")
                            .font(AppFont.footnote())
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 18)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { titleText }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if let onOpen {
                    Button {
                        dismiss()
                        onOpen()
                    } label: {
                        HStack(spacing: 8) {
                            Text("Open child thread")
                            Image(systemName: "arrow.right")
                        }
                        .font(AppFont.body(weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                    }
                    .buttonStyle(.plain)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(Color.accentColor.opacity(0.12))
                    )
                    .padding(.horizontal, 20)
                    .padding(.top, 10)
                    .padding(.bottom, 12)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var titleText: some View {
        SubagentLabelParser.styledText(for: title)
            .font(AppFont.body(weight: .semibold))
            .lineLimit(1)
    }

    private var statusSection: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(accentColor.opacity(0.18))
                .frame(width: 36, height: 36)
                .overlay {
                    Circle().fill(accentColor).frame(width: 10, height: 10)
                }

            VStack(alignment: .leading, spacing: 2) {
                Text("Status")
                    .font(AppFont.caption(weight: .semibold))
                    .foregroundStyle(.secondary)
                Text(statusText)
                    .font(AppFont.body())
                    .foregroundStyle(.primary)
            }

            Spacer(minLength: 0)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(.secondarySystemBackground))
        )
    }

    @ViewBuilder
    private func detailSection(title: String, value: String, monospace: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(AppFont.caption(weight: .semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(monospace ? AppFont.mono(.footnote) : AppFont.footnote())
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
