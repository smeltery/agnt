// FILE: MessageRow+System.swift
// Purpose: System-message rendering helpers for MessageRow.
// Layer: View Components

import SwiftUI

extension MessageRow {
    @ViewBuilder
    func systemView(text: String, renderModel: MessageRowRenderModel) -> some View {
        switch message.kind {
        case .thinking:
            thinkingSystemView(renderModel: renderModel)
        case .toolActivity:
            toolActivitySystemView(text: text)
        case .fileChange:
            fileChangeSystemView(text: text, renderModel: renderModel)
        case .commandExecution:
            commandExecutionSystemView(text: text, renderModel: renderModel)
        case .subagentAction:
            subagentActionSystemView(text: text)
        case .plan:
            if message.resolvedPlanPresentation?.isInlineResultVisible == true,
               let proposedPlan = message.proposedPlan {
                ProposedPlanResultCard(
                    threadId: message.threadId,
                    proposedPlan: proposedPlan,
                    isStreaming: message.isStreaming,
                    canImplement: message.resolvedPlanPresentation == .resultReady
                )
            } else {
                PlanSystemCard(message: message)
            }
        case .userInputPrompt:
            if let request = message.structuredUserInputRequest {
                StructuredUserInputCard(request: request)
                    .id(request.requestID)
            } else {
                defaultSystemView(text: text)
            }
        case .chat:
            defaultSystemView(text: text)
        }
    }

    @ViewBuilder
    private func thinkingSystemView(renderModel: MessageRowRenderModel) -> some View {
        ThinkingSystemBlock(
            messageID: message.id,
            isStreaming: message.isStreaming,
            thinkingText: renderModel.thinkingText ?? "",
            thinkingContent: renderModel.thinkingContent ?? ThinkingDisclosureContent(sections: [], fallbackText: ""),
            activityPreview: renderModel.thinkingActivityPreview
        )
    }

    private func toolActivitySystemView(text: String) -> some View {
        let joined = text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")

        return VStack(alignment: .leading, spacing: 4) {
            if !joined.isEmpty {
                Text(joined)
                    .font(AppFont.body(weight: .regular))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
        .contextMenu {
            selectableTextActions(text: text, usesMarkdownSelection: false)
        }
    }

    @ViewBuilder
    private func fileChangeSystemView(text: String, renderModel: MessageRowRenderModel) -> some View {
        let renderState = renderModel.fileChangeState ?? FileChangeRenderState(
            summary: nil,
            actionEntries: [],
            bodyText: text
        )
        let actionEntries = renderState.actionEntries
        let hasActionRows = !actionEntries.isEmpty
        let allEntries = hasActionRows ? actionEntries : (renderState.summary?.entries ?? [])
        let fallbackText = renderState.bodyText.trimmingCharacters(in: .whitespacesAndNewlines)

        if message.isStreaming {
            fileChangeStreamingSystemView(
                text: text,
                entries: allEntries,
                fallbackText: fallbackText
            )
        } else {
            VStack(alignment: .leading, spacing: 8) {
                FileChangeSummaryBox(
                    entries: allEntries,
                    fallbackText: fallbackText,
                    messageID: message.id
                )
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contextMenu {
                selectableTextActions(text: text, usesMarkdownSelection: false)
            }
        }
    }

    private func fileChangeStreamingSystemView(
        text: String,
        entries: [TurnFileChangeSummaryEntry],
        fallbackText: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if entries.isEmpty {
                Text(fallbackText.isEmpty ? text : fallbackText)
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(entries) { entry in
                    FileChangeInlineActionRow(entry: entry)
                }
            }

        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            selectableTextActions(text: text, usesMarkdownSelection: false)
        }
    }

    private func defaultSystemView(text: String) -> some View {
        Text(text)
            .font(AppFont.footnote())
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 2)
            .contextMenu {
                selectableTextActions(text: text, usesMarkdownSelection: false)
            }
    }

    @ViewBuilder
    private func commandExecutionSystemView(text: String, renderModel: MessageRowRenderModel) -> some View {
        if message.role == .system,
           message.kind == .commandExecution,
           !text.isEmpty,
           let commandStatus = renderModel.commandStatus {
            CommandExecutionStatusCard(status: commandStatus, itemId: message.itemId)
        } else {
            defaultSystemView(text: text)
        }
    }

    @ViewBuilder
    private func subagentActionSystemView(text: String) -> some View {
        if let subagentAction = message.subagentAction {
            SubagentActionCard(
                parentThreadId: message.threadId,
                action: subagentAction,
                onOpenSubagent: subagentOpenAction
            )
        } else {
            defaultSystemView(text: text)
        }
    }
}
