// FILE: TurnViewModelModels.swift
// Purpose: Value models used by TurnViewModel and composer state restoration.
// Layer: View Model
// Exports: TurnComposerSendAvailability, TurnComposerAttachmentIntakePlan, QueuedTurnDraft, TurnComposerLocalDraft, QueuePauseState
// Depends on: Foundation

import Foundation

struct TurnComposerSendAvailability {
    let isSending: Bool
    let isConnected: Bool
    let trimmedInput: String
    let hasReadyImages: Bool
    let hasBlockingAttachmentState: Bool
    let hasSkillSelection: Bool
    let hasPluginSelection: Bool
    let hasReviewSelection: Bool
    let hasPendingReviewSelection: Bool
    let hasSubagentsSelection: Bool

    // Evaluates whether sending is allowed for the current composer state.
    var isSendDisabled: Bool {
        isSending
            || !isConnected
            || hasPendingReviewSelection
            || (
                trimmedInput.isEmpty
                    && !hasReadyImages
                    && !hasSkillSelection
                    && !hasPluginSelection
                    && !hasReviewSelection
                    && !hasSubagentsSelection
            )
            || hasBlockingAttachmentState
    }
}

struct TurnComposerAttachmentIntakePlan {
    let acceptedCount: Int
    let droppedCount: Int

    var hasOverflow: Bool {
        droppedCount > 0
    }

    // Computes how many picker items can be accepted without exceeding attachment slots.
    static func make(requestedCount: Int, remainingSlots: Int) -> TurnComposerAttachmentIntakePlan {
        let safeRequestedCount = max(0, requestedCount)
        let safeRemainingSlots = max(0, remainingSlots)
        let acceptedCount = min(safeRequestedCount, safeRemainingSlots)
        let droppedCount = safeRequestedCount - acceptedCount
        return TurnComposerAttachmentIntakePlan(acceptedCount: acceptedCount, droppedCount: droppedCount)
    }
}

struct QueuedTurnDraft: Identifiable {
    let id: String
    // Points at the optimistic timeline bubble shown while this draft waits behind a running turn.
    let preAppendedMessageID: String?
    let text: String
    let attachments: [CodexImageAttachment]
    let skillMentions: [CodexTurnSkillMention]
    let mentionMentions: [CodexTurnMention]
    // Preserves special send semantics, such as plan mode, while a busy thread queues locally.
    let collaborationMode: CodexCollaborationModeKind?
    // Preserves the original composer state so a queued row can move back into the input intact.
    let rawInput: String
    let rawFileMentions: [TurnComposerMentionedFile]
    let rawSkillMentions: [TurnComposerMentionedSkill]
    let rawPluginMentions: [TurnComposerMentionedPlugin]
    let rawAttachments: [TurnComposerImageAttachment]
    let rawSubagentsSelectionArmed: Bool
    let createdAt: Date

    init(
        id: String,
        preAppendedMessageID: String? = nil,
        text: String,
        attachments: [CodexImageAttachment],
        skillMentions: [CodexTurnSkillMention],
        mentionMentions: [CodexTurnMention] = [],
        collaborationMode: CodexCollaborationModeKind?,
        rawInput: String? = nil,
        rawFileMentions: [TurnComposerMentionedFile] = [],
        rawSkillMentions: [TurnComposerMentionedSkill] = [],
        rawPluginMentions: [TurnComposerMentionedPlugin] = [],
        rawAttachments: [TurnComposerImageAttachment] = [],
        rawSubagentsSelectionArmed: Bool = false,
        createdAt: Date
    ) {
        self.id = id
        self.preAppendedMessageID = preAppendedMessageID
        self.text = text
        self.attachments = attachments
        self.skillMentions = skillMentions
        self.mentionMentions = mentionMentions
        self.collaborationMode = collaborationMode
        self.rawInput = rawInput ?? text
        self.rawFileMentions = rawFileMentions
        self.rawSkillMentions = rawSkillMentions
        self.rawPluginMentions = rawPluginMentions
        self.rawAttachments = rawAttachments
        self.rawSubagentsSelectionArmed = rawSubagentsSelectionArmed
        self.createdAt = createdAt
    }

    // Carries the optimistic row id without rebuilding queue payloads at call sites.
    func withPreAppendedMessageID(_ messageID: String?) -> QueuedTurnDraft {
        QueuedTurnDraft(
            id: id,
            preAppendedMessageID: messageID,
            text: text,
            attachments: attachments,
            skillMentions: skillMentions,
            mentionMentions: mentionMentions,
            collaborationMode: collaborationMode,
            rawInput: rawInput,
            rawFileMentions: rawFileMentions,
            rawSkillMentions: rawSkillMentions,
            rawPluginMentions: rawPluginMentions,
            rawAttachments: rawAttachments,
            rawSubagentsSelectionArmed: rawSubagentsSelectionArmed,
            createdAt: createdAt
        )
    }
}

struct TurnComposerLocalDraft: Codable, Equatable, Sendable {
    let input: String
    let mentionedFiles: [TurnComposerMentionedFile]
    let mentionedSkills: [TurnComposerMentionedSkill]
    let mentionedPlugins: [TurnComposerMentionedPlugin]
    let attachments: [TurnComposerImageAttachment]
    let reviewSelection: TurnComposerReviewSelection?
    let isPlanModeArmed: Bool
    let isSubagentsSelectionArmed: Bool
    let updatedAt: Date

    nonisolated var isEmpty: Bool {
        input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && mentionedFiles.isEmpty
            && mentionedSkills.isEmpty
            && mentionedPlugins.isEmpty
            && attachments.isEmpty
            && reviewSelection == nil
            && !isPlanModeArmed
            && !isSubagentsSelectionArmed
    }

    static func make(
        input: String,
        mentionedFiles: [TurnComposerMentionedFile],
        mentionedSkills: [TurnComposerMentionedSkill],
        mentionedPlugins: [TurnComposerMentionedPlugin],
        attachments: [TurnComposerImageAttachment],
        reviewSelection: TurnComposerReviewSelection?,
        isPlanModeArmed: Bool,
        isSubagentsSelectionArmed: Bool,
        updatedAt: Date = Date()
    ) -> TurnComposerLocalDraft {
        TurnComposerLocalDraft(
            input: input,
            mentionedFiles: mentionedFiles,
            mentionedSkills: mentionedSkills,
            mentionedPlugins: mentionedPlugins,
            attachments: attachments.compactMap { attachment in
                guard case .ready = attachment.state else { return nil }
                return attachment
            },
            reviewSelection: reviewSelection,
            isPlanModeArmed: isPlanModeArmed,
            isSubagentsSelectionArmed: isSubagentsSelectionArmed,
            updatedAt: updatedAt
        )
    }
}

enum QueuePauseState: Equatable {
    case active
    case paused(errorMessage: String)
}

struct TurnComposerMentionedFile: Identifiable, Codable, Equatable, Sendable {
    let id: String
    let fileName: String
    let path: String

    init(id: String = UUID().uuidString, fileName: String, path: String) {
        self.id = id
        self.fileName = fileName
        self.path = path
    }
}

struct TurnComposerMentionedSkill: Identifiable, Codable, Equatable, Sendable {
    let id: String
    let name: String
    let path: String?
    let description: String?

    init(id: String = UUID().uuidString, name: String, path: String?, description: String?) {
        self.id = id
        self.name = name
        self.path = path
        self.description = description
    }
}

struct TurnComposerMentionedPlugin: Identifiable, Codable, Equatable, Sendable {
    let id: String
    let name: String
    let path: String
    let displayName: String?

    init(id: String = UUID().uuidString, name: String, path: String, displayName: String?) {
        self.id = id
        self.name = name
        self.path = path
        self.displayName = displayName
    }
}

struct TurnSkillSearchIndexEntry: Equatable {
    let skill: CodexSkillMetadata
    let name: String
    let displayName: String
    let description: String

    init(skill: CodexSkillMetadata) {
        self.skill = skill
        self.name = skill.name.lowercased()
        self.displayName = SkillDisplayNameFormatter.displayName(for: skill.name).lowercased()
        self.description = skill.description?.lowercased() ?? ""
    }

    func matchScore(for needle: String) -> Int? {
        if name == needle || displayName == needle {
            return 0
        }
        if name.hasPrefix(needle) || displayName.hasPrefix(needle) {
            return 1
        }
        if name.contains(needle) || displayName.contains(needle) {
            return 2
        }
        if description.hasPrefix(needle) {
            return 3
        }
        if description.contains(needle) {
            return 4
        }
        return nil
    }
}

struct TurnPluginSearchIndexEntry: Equatable {
    let plugin: CodexPluginMetadata
    let searchBlob: String

    init(plugin: CodexPluginMetadata) {
        self.plugin = plugin
        self.searchBlob = plugin.searchBlob
    }
}
