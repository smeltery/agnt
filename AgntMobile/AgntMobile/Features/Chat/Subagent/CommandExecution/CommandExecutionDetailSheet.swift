// FILE: CommandExecutionDetailSheet.swift
// Purpose: Command execution detail sheet and previews.
// Layer: View Components

import SwiftUI

// MARK: - Detail Sheet

struct CommandExecutionDetailSheet: View {
    let status: CommandExecutionStatusModel
    let details: CommandExecutionDetails?
    @Environment(\.dismiss) private var dismiss
    @State private var isOutputExpanded = false
    private let commandAccent = CommandExecutionStatusAccent.running.color

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                commandSection
                metadataSection
                if let details, !details.outputTail.isEmpty {
                    outputSection
                }
            }
            .padding()
        }
        .presentationDragIndicator(.visible)
    }

    private var commandSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Command", systemImage: "terminal.fill")
                .font(AppFont.mono(.caption))
                .foregroundStyle(commandAccent)

            Text(details?.fullCommand ?? status.command)
                .font(AppFont.mono(.callout))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color(.secondarySystemBackground))
                )
        }
    }

    private var metadataSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let cwd = details?.cwd, !cwd.isEmpty {
                metadataRow(label: "Directory", value: cwd)
            }
            if let exitCode = details?.exitCode {
                metadataRow(
                    label: "Exit code",
                    value: "\(exitCode)",
                    valueColor: exitCode == 0 ? .green : .red
                )
            }
            if let durationMs = details?.durationMs {
                metadataRow(label: "Duration", value: formattedDuration(durationMs))
            }
            metadataRow(label: "Status", value: status.statusLabel, valueColor: status.accent.color)
        }
    }

    private func metadataRow(label: String, value: String, valueColor: Color = .primary) -> some View {
        HStack {
            Text(label)
                .font(AppFont.mono(.caption))
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(AppFont.mono(.caption))
                .foregroundStyle(valueColor)
                .textSelection(.enabled)
        }
    }

    private var outputSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isOutputExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isOutputExpanded ? "chevron.down" : "chevron.right")
                        .font(AppFont.system(size: 10, weight: .semibold))
                    Text("Output (last \(CommandExecutionDetails.maxOutputLines) lines)")
                        .font(AppFont.mono(.caption))
                }
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)

            if isOutputExpanded, let output = details?.outputTail {
                Text(output)
                    .font(AppFont.mono(.caption2))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(Color(.secondarySystemBackground))
                    )
            }
        }
    }

    private func formattedDuration(_ ms: Int) -> String {
        if ms < 1000 { return "\(ms)ms" }
        let seconds = Double(ms) / 1000.0
        if seconds < 60 { return String(format: "%.1fs", seconds) }
        let minutes = Int(seconds) / 60
        let remainingSeconds = Int(seconds) % 60
        return "\(minutes)m \(remainingSeconds)s"
    }
}

// MARK: - Previews

#Preview("Humanized Commands") {
    VStack(alignment: .leading, spacing: 12) {
        CommandExecutionCardBody(
            command: "/usr/bin/bash -lc \"cd /home/user/project && npm install\"",
            statusLabel: "running",
            accent: .running
        )
        CommandExecutionCardBody(
            command: "nl -ba apps/server/src/provider/Layers.swift",
            statusLabel: "completed",
            accent: .completed
        )
        CommandExecutionCardBody(
            command: "rg -n \"project.model\" apps/server/src",
            statusLabel: "completed",
            accent: .completed
        )
        CommandExecutionCardBody(
            command: "git status",
            statusLabel: "completed",
            accent: .completed
        )
        CommandExecutionCardBody(
            command: "python3 train.py --epochs 100 --lr 0.001",
            statusLabel: "failed",
            accent: .failed
        )
    }
    .padding(.horizontal, 16)
}
