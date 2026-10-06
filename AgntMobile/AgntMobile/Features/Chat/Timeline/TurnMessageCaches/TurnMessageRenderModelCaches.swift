// FILE: TurnMessageRenderModelCaches.swift
// Purpose: Message row render-model and command/file-change render-state caches.
// Layer: View Support

import Foundation
struct FileChangeRenderState {
    let summary: TurnFileChangeSummary?
    let actionEntries: [TurnFileChangeSummaryEntry]
    let bodyText: String
}

struct MessageRowRenderModel {
    let codeCommentContent: CodeCommentDirectiveContent?
    let mermaidContent: MermaidMarkdownContent?
    let assistantImageReferences: [AssistantMarkdownImageReference]
    let assistantInlineContentSegments: [AssistantMarkdownContentSegment]
    let assistantTextWithoutImageSyntax: String?
    let fileChangeState: FileChangeRenderState?
    let fileChangeGroups: [FileChangeGroup]
    let thinkingContent: ThinkingDisclosureContent?
    let thinkingText: String?
    let thinkingActivityPreview: String?
    let commandStatus: CommandExecutionStatusModel?

    static let empty = MessageRowRenderModel(
        codeCommentContent: nil,
        mermaidContent: nil,
        assistantImageReferences: [],
        assistantInlineContentSegments: [],
        assistantTextWithoutImageSyntax: nil,
        fileChangeState: nil,
        fileChangeGroups: [],
        thinkingContent: nil,
        thinkingText: nil,
        thinkingActivityPreview: nil,
        commandStatus: nil
    )
}

enum MessageRowRenderModelCache {
    private static let cache = BoundedCache<String, MessageRowRenderModel>(maxEntries: 512)

    static func model(for message: CodexMessage, displayText: String) -> MessageRowRenderModel {
        let textFingerprint = message.isStreaming
            ? TurnTextCacheKey.fingerprint(for: displayText)
            : TurnTextCacheKey.stableFingerprint(for: displayText)
        let key = "\(message.id)|\(message.kind.rawValue)|\(message.role.rawValue)|\(message.isStreaming)|\(textFingerprint)"
        return cache.getOrSet(key) { buildModel(for: message, displayText: displayText) }
    }

    static func reset() {
        cache.removeAll()
    }

    private static func buildModel(for message: CodexMessage, displayText: String) -> MessageRowRenderModel {
        switch message.role {
        case .assistant:
            let assistantImageReferences = message.isStreaming
                ? []
                : AssistantMarkdownImageReferenceParser.references(in: displayText)
            let assistantTextWithoutImageSyntax = assistantImageReferences.isEmpty
                ? nil
                : AssistantMarkdownImageReferenceParser.visibleTextRemovingImageSyntax(from: displayText)
            let assistantInlineContentSegments = assistantImageReferences.contains(where: \.isTemporaryScreenshotImage)
                ? AssistantMarkdownImageReferenceParser.contentSegmentsPreservingTemporaryImages(from: displayText)
                : []
            let assistantRenderText = assistantTextWithoutImageSyntax ?? displayText
            // Defer Mermaid parsing until the assistant row is finalized so streaming deltas
            // keep the lightweight append-only path and avoid repeated parser/WebKit churn.
            return MessageRowRenderModel(
                codeCommentContent: message.isStreaming
                    ? nil
                    : CodeCommentDirectiveContentCache.content(messageID: message.id, text: displayText),
                mermaidContent: message.isStreaming
                    ? nil
                    : MermaidMarkdownContentCache.content(
                        messageID: message.id,
                        text: assistantRenderText
                ),
                assistantImageReferences: assistantImageReferences,
                assistantInlineContentSegments: assistantInlineContentSegments,
                assistantTextWithoutImageSyntax: assistantTextWithoutImageSyntax,
                fileChangeState: nil,
                fileChangeGroups: [],
                thinkingContent: nil,
                thinkingText: nil,
                thinkingActivityPreview: nil,
                commandStatus: nil
            )
        case .user:
            return .empty
        case .system:
            switch message.kind {
            case .thinking:
                let thinkingText = ThinkingDisclosureParser.normalizedThinkingContent(from: message.text)
                let thinkingActivityPreview = thinkingText.isEmpty
                    ? nil
                    : ThinkingDisclosureParser.compactActivityPreview(fromNormalizedText: thinkingText)
                return MessageRowRenderModel(
                    codeCommentContent: nil,
                    mermaidContent: nil,
                    assistantImageReferences: [],
                    assistantInlineContentSegments: [],
                    assistantTextWithoutImageSyntax: nil,
                    fileChangeState: nil,
                    fileChangeGroups: [],
                    thinkingContent: thinkingText.isEmpty
                        ? ThinkingDisclosureContent(sections: [], fallbackText: "")
                        : ThinkingDisclosureContentCache.content(messageID: message.id, text: thinkingText),
                    thinkingText: thinkingText,
                    thinkingActivityPreview: thinkingActivityPreview,
                    commandStatus: nil
                )
            case .fileChange:
                let fileChangeState = FileChangeSystemRenderCache.renderState(
                    messageID: message.id,
                    sourceText: displayText
                )
                let actionEntries = fileChangeState.actionEntries
                let allEntries = actionEntries.isEmpty ? (fileChangeState.summary?.entries ?? []) : actionEntries
                return MessageRowRenderModel(
                    codeCommentContent: nil,
                    mermaidContent: nil,
                    assistantImageReferences: [],
                    assistantInlineContentSegments: [],
                    assistantTextWithoutImageSyntax: nil,
                    fileChangeState: fileChangeState,
                    fileChangeGroups: FileChangeGroupingCache.grouped(messageID: message.id, entries: allEntries),
                    thinkingContent: nil,
                    thinkingText: nil,
                    thinkingActivityPreview: nil,
                    commandStatus: nil
                )
            case .toolActivity:
                return .empty
            case .commandExecution:
                return MessageRowRenderModel(
                    codeCommentContent: nil,
                    mermaidContent: nil,
                    assistantImageReferences: [],
                    assistantInlineContentSegments: [],
                    assistantTextWithoutImageSyntax: nil,
                    fileChangeState: nil,
                    fileChangeGroups: [],
                    thinkingContent: nil,
                    thinkingText: nil,
                    thinkingActivityPreview: nil,
                    commandStatus: CommandExecutionStatusCache.status(messageID: message.id, text: displayText)
                )
            case .subagentAction, .plan, .userInputPrompt, .autoApprovalReview, .chat, .asyncUserInputAnswer:
                return .empty
            }
        }
    }
}

enum CommandExecutionStatusCache {
    private static let cache = BoundedCache<String, CommandExecutionStatusModel>(maxEntries: 256)

    static func status(messageID: String, text: String) -> CommandExecutionStatusModel? {
        let key = TurnTextCacheKey.key(messageID: messageID, kind: "command-status", text: text)
        if let cached = cache.get(key) { return cached }
        guard let parsed = parse(text) else { return nil }
        cache.set(key, value: parsed)
        return parsed
    }

    static func reset() { cache.removeAll() }

    private static func parse(_ text: String) -> CommandExecutionStatusModel? {
        let words = text.split(whereSeparator: \.isWhitespace)
        guard let first = words.first?.lowercased() else { return nil }
        let command = words.dropFirst().joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        let commandLabel = command.isEmpty ? "command" : command

        switch first {
        case "running":
            return CommandExecutionStatusModel(command: commandLabel, statusLabel: "running", accent: .running)
        case "completed":
            return CommandExecutionStatusModel(command: commandLabel, statusLabel: "completed", accent: .completed)
        case "failed", "stopped":
            return CommandExecutionStatusModel(command: commandLabel, statusLabel: first, accent: .failed)
        default:
            return nil
        }
    }
}

enum FileChangeSystemRenderCache {
    private static let cache = BoundedCache<String, FileChangeRenderState>(maxEntries: 256)

    static func reset() { cache.removeAll() }

    static func renderState(messageID: String, sourceText: String) -> FileChangeRenderState {
        cache.getOrSet(TurnTextCacheKey.key(messageID: messageID, kind: "file-change-render", text: sourceText)) {
            let summary = TurnFileChangeSummaryParser.parse(from: sourceText)
            let actionEntries = summary?.entries.filter { $0.action != nil } ?? []
            let bodyText = actionEntries.isEmpty
                ? sourceText
                : TurnFileChangeSummaryParser.removingInlineEditingRows(from: sourceText)
            return FileChangeRenderState(
                summary: summary,
                actionEntries: actionEntries,
                bodyText: bodyText
            )
        }
    }
}
