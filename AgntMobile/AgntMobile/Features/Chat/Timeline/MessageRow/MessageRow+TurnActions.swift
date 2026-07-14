// FILE: MessageRow+TurnActions.swift
// Purpose: Turn-end action and selectable-text helpers for MessageRow.
// Layer: View Components

import SwiftUI
import UIKit

extension MessageRow {
    var hasTurnEndActions: Bool {
        AssistantTurnEndActionVisibility.shouldShow(
            accessoryState: assistantBlockAccessoryState
        )
    }

    private var isInlineCommitAndPushRunning: Bool {
        inlineCommitAndPushPhase != nil
    }

    private var inlineCommitAndPushTitle: String {
        inlineCommitAndPushPhase?.title ?? "Commit & Push"
    }

    @ViewBuilder
    var turnEndActionButtons: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let accessory = assistantBlockAccessoryState,
               let revert = accessory.blockRevertPresentation {
                assistantRevertButton(
                    presentation: revert,
                    targetMessage: accessory.blockRevertMessage ?? message
                )
            }

            if let accessory = assistantBlockAccessoryState {
                HStack(spacing: 10) {
                    if let entries = accessory.blockDiffEntries, !entries.isEmpty {
                        let totalAdditions = entries.reduce(0) { $0 + $1.additions }
                        let totalDeletions = entries.reduce(0) { $0 + $1.deletions }

                        Button {
                            isShowingBlockDiffSheet = true
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "doc.text.magnifyingglass")
                                    .font(AppFont.system(size: 10, weight: .medium))
                                Text("Diff")
                                DiffCountsLabel(additions: totalAdditions, deletions: totalDeletions)
                            }
                            .font(AppFont.mono(.body))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .sheet(isPresented: $isShowingBlockDiffSheet) {
                            TurnDiffSheet(
                                title: "Changes",
                                entries: entries,
                                bodyText: accessory.blockDiffText ?? "",
                                messageID: message.id
                            )
                        }
                    }

                    if let action = inlineCommitAction {
                        Button {
                            HapticFeedback.shared.triggerImpactFeedback(style: .light)
                            action()
                        } label: {
                            HStack(spacing: 4) {
                                // Mirror the top-bar git feedback so the inline CTA feels responsive too.
                                Group {
                                    if isInlineCommitAndPushRunning {
                                        ProgressView()
                                            .controlSize(.small)
                                    } else {
                                        Image("cloud-upload")
                                            .renderingMode(.template)
                                            .resizable()
                                            .scaledToFit()
                                    }
                                }
                                    .frame(width: 18, height: 18)
                                Text(inlineCommitAndPushTitle)
                            }
                            .font(AppFont.mono(.body))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(isInlineCommitAndPushRunning)
                    }
                }
            }
        }
    }

    private func assistantRevertButton(
        presentation: AssistantRevertPresentation,
        targetMessage: CodexMessage
    ) -> some View {
        let iconName: String = {
            switch presentation.riskLevel {
            case .safe:
                return "arrow.uturn.backward.circle"
            case .warning:
                return "exclamationmark.circle"
            case .blocked:
                return "exclamationmark.triangle"
            }
        }()
        let accentColor: Color = {
            switch presentation.riskLevel {
            case .safe:
                return .primary
            case .warning:
                return .orange
            case .blocked:
                return .secondary
            }
        }()

        return Button {
            guard presentation.isEnabled else { return }
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            assistantRevertAction?(targetMessage)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: iconName)
                    .font(AppFont.system(size: 10, weight: .medium))
                    .foregroundStyle(accentColor)
                Text(presentation.title)
                    .lineLimit(1)
            }
            .font(AppFont.mono(.body))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!presentation.isEnabled)
        .accessibilityHint(presentation.warningText ?? presentation.helperText ?? "")
    }

    @ViewBuilder
    func selectableTextActions(text: String, usesMarkdownSelection: Bool) -> some View {
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedText.isEmpty {
            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                selectableTextSheet = SelectableMessageTextSheetState(
                    role: message.role,
                    text: trimmedText,
                    usesMarkdownSelection: usesMarkdownSelection
                )
            } label: {
                Label("Select Text", systemImage: "text.cursor")
            }

            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                UIPasteboard.general.string = trimmedText
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
        }
    }
}
