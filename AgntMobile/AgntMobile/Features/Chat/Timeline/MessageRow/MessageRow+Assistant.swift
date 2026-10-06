// FILE: MessageRow+Assistant.swift
// Purpose: Assistant-message rendering helpers for MessageRow.
// Layer: View Components

import SwiftUI

extension MessageRow {
    func assistantView(text: String, renderModel: MessageRowRenderModel) -> some View {
        let commentContent = renderModel.codeCommentContent
        let bodyText = commentContent?.fallbackText ?? text
        let mermaidContent = renderModel.mermaidContent
        let shouldParseStructuredAssistantContent = !message.isStreaming
        let assistantProposedPlanCandidate = shouldParseStructuredAssistantContent
            && commentContent == nil && mermaidContent == nil
            ? (message.proposedPlan ?? CodexProposedPlanParser.parse(from: bodyText))
            : nil
        let currentPlanSessionSource = planSessionSource
        let isNativePlanSession = currentPlanSessionSource != nil && currentPlanSessionSource != .compatibilityFallback
        let proposedPlan = !isNativePlanSession
            ? (assistantProposedPlanCandidate
                ?? (
                    commentContent == nil
                        && mermaidContent == nil
                        && currentPlanSessionSource == .compatibilityFallback
                        && InferredPlanQuestionnaireParser.parseAssistantMessage(bodyText) == nil
                    ? CodexProposedPlanParser.parseAssistantFallback(from: bodyText)
                            : nil
                ))
            : nil
        let renderedPlanText = assistantProposedPlanCandidate == nil
            ? bodyText
            : (
                CodexProposedPlanParser.containsEnvelope(in: bodyText)
                    ? (CodexProposedPlanParser.removingEnvelope(from: bodyText) ?? "")
                    : ""
            )
        let inferredQuestionnaire = shouldParseStructuredAssistantContent && commentContent == nil
            ? resolvedInferredPlanQuestionnaire(
                bodyText: bodyText,
                message: message,
                threadMessages: threadMessagesForPlanMatching,
                shouldRecoverFallback: allowsAssistantPlanFallbackRecovery,
                parse: InferredPlanQuestionnaireParser.parseAssistantMessage
            )
            : nil
        let visibleAssistantText = renderedPlanText
        let suppressNativeProposedPlanShell = isNativePlanSession
            && assistantProposedPlanCandidate != nil
            && visibleAssistantText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && inferredQuestionnaire == nil
            && mermaidContent == nil
        let usesCachedAssistantImageContent = !message.isStreaming && visibleAssistantText == bodyText
        let assistantImageReferences = usesCachedAssistantImageContent
            ? renderModel.assistantImageReferences
            : []
        let assistantInlineContentSegments = usesCachedAssistantImageContent
            ? renderModel.assistantInlineContentSegments
            : []
        let trailingAssistantImageReferences = assistantImageReferences.filter {
            !$0.isTemporaryScreenshotImage
                && $0.canPreview(currentWorkingDirectory: currentWorkingDirectory)
        }
        let visibleAssistantTextWithoutImageSyntax = assistantImageReferences.isEmpty
            ? visibleAssistantText
            : (renderModel.assistantTextWithoutImageSyntax ?? visibleAssistantText)
        let trimmedVisibleAssistantText = visibleAssistantTextWithoutImageSyntax
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let hasVisibleAssistantText = !trimmedVisibleAssistantText.isEmpty
        let assistantImageAttachments = message.isStreaming
            ? []
            : message.attachments.filter(\.hasPreviewPayload)
        let rendersTemporaryImagesInline = !assistantInlineContentSegments.isEmpty
            && !message.isStreaming
            && mermaidContent == nil
            && proposedPlan == nil
            && inferredQuestionnaire == nil
        let hasRenderableAssistantContent = hasVisibleAssistantText
            || proposedPlan != nil
            || !trailingAssistantImageReferences.isEmpty
            || rendersTemporaryImagesInline
            || !assistantImageAttachments.isEmpty
        // Copy only the visible prose. Image-only artifact rows should not expose a
        // second copy affordance for the hidden markdown image syntax.
        let assistantCopyText: String? = {
            if !trimmedVisibleAssistantText.isEmpty {
                return trimmedVisibleAssistantText
            }
            return trailingAssistantImageReferences.isEmpty ? assistantBlockAccessoryState?.copyText : nil
        }()
        return VStack(alignment: .leading, spacing: 8) {
            if let input = message.asyncUserInput {
                AsyncUserInputMessageCard(message: message, input: input)
            }
            if let commentContent, commentContent.hasFindings {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(commentContent.findings) { finding in
                        CodeCommentFindingCard(finding: finding)
                    }
                }
            }

            if hasRenderableAssistantContent {
                if let mermaidContent {
                    MermaidMarkdownContentView(content: mermaidContent)
                } else if let inferredQuestionnaire {
                    if let introText = inferredQuestionnaire.introText {
                        MarkdownTextView(
                            text: introText,
                            profile: .assistantProse,
                            enablesSelection: enablesInlineMarkdownSelectionInTimeline,
                            constrainsToAvailableWidth: true
                        )
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
                } else if let proposedPlan {
                    // Compatibility-mode proposed plans still render inline from assistant text.
                    if !renderedPlanText.isEmpty {
                        MarkdownTextView(
                            text: renderedPlanText,
                            profile: .assistantProse,
                            enablesSelection: enablesInlineMarkdownSelectionInTimeline,
                            constrainsToAvailableWidth: true
                        )
                    }

                    ProposedPlanResultCard(
                        threadId: message.threadId,
                        proposedPlan: proposedPlan,
                        isStreaming: message.isStreaming,
                        canImplement: assistantTurnCompleted
                    )
                } else if rendersTemporaryImagesInline {
                    ForEach(assistantInlineContentSegments) { segment in
                        switch segment {
                        case .text(_, let segmentText):
                            MarkdownTextView(
                                text: segmentText,
                                profile: .assistantProse,
                                enablesSelection: enablesInlineMarkdownSelectionInTimeline,
                                constrainsToAvailableWidth: true
                            )
                        case .image(let reference):
                            if reference.canPreview(currentWorkingDirectory: currentWorkingDirectory) {
                                AssistantMarkdownImagePreviewButton(
                                    reference: reference,
                                    currentWorkingDirectory: currentWorkingDirectory
                                )
                            }
                        }
                    }
                } else if message.isStreaming {
                    streamingAssistantContent(
                        hasVisibleAssistantText: hasVisibleAssistantText,
                        visibleAssistantTextWithoutImageSyntax: visibleAssistantTextWithoutImageSyntax
                    )
                } else {
                    if hasVisibleAssistantText {
                        MarkdownTextView(
                            text: visibleAssistantTextWithoutImageSyntax,
                            profile: .assistantProse,
                            enablesSelection: enablesInlineMarkdownSelectionInTimeline,
                            constrainsToAvailableWidth: true
                        )
                    }
                }

                if !trailingAssistantImageReferences.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(trailingAssistantImageReferences) { reference in
                            AssistantMarkdownImagePreviewButton(
                                reference: reference,
                                currentWorkingDirectory: currentWorkingDirectory
                            )
                        }
                    }
                }

                if !assistantImageAttachments.isEmpty {
                    UserAttachmentStrip(attachments: assistantImageAttachments) { tappedAttachment in
                        if let image = AttachmentPreviewImageResolver.resolve(tappedAttachment) {
                            previewImage = PreviewImagePayload(image: image)
                        }
                    }
                    .padding(.top, trailingAssistantImageReferences.isEmpty ? 0 : 4)
                }
            }

            if !suppressNativeProposedPlanShell && hasTurnEndActions {
                turnEndActionButtons
            }

            if !suppressNativeProposedPlanShell, let assistantBlockAccessoryState {
                CopyBlockButton(
                    text: assistantBlockAccessoryState.allowsCopy ? assistantCopyText : nil,
                    isRunning: assistantBlockAccessoryState.showsRunningIndicator
                )
            }

        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            selectableTextActions(text: text, usesMarkdownSelection: true)
        }
    }

    @ViewBuilder
    private func streamingAssistantContent(
        hasVisibleAssistantText: Bool,
        visibleAssistantTextWithoutImageSyntax: String
    ) -> some View {
        if hasVisibleAssistantText {
            StreamingAssistantMarkdownTextView(
                text: visibleAssistantTextWithoutImageSyntax,
                enablesSelection: enablesInlineMarkdownSelectionInTimeline,
                constrainsToAvailableWidth: true,
                animatesReveal: showsStreamingAnimations
            )
        }
    }
}
