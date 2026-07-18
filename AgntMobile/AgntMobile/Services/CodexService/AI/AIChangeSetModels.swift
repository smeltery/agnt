// FILE: AIChangeSetModels.swift
// Purpose: Models assistant-scoped code change sets and revert preview/apply results.
// Layer: Model
// Exports: AIChangeSetTurnKey, AIChangeSet, AIFileChange, RevertPreviewResult, RevertApplyResult,
//   AssistantRevertRiskLevel, AssistantRevertPresentation
// Depends on: Foundation

import Foundation

struct AIChangeSetTurnKey: Hashable, Sendable {
    let threadId: String
    let turnId: String

    init?(threadId: String?, turnId: String?) {
        guard let threadId = threadId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !threadId.isEmpty,
              let turnId = turnId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !turnId.isEmpty else {
            return nil
        }

        self.threadId = threadId
        self.turnId = turnId
    }
}

enum AIFileChangeKind: String, Codable, Hashable, Sendable {
    case create
    case update
    case delete
}

struct AIFileChange: Identifiable, Codable, Hashable, Sendable {
    var id: String { path }

    let path: String
    let kind: AIFileChangeKind
    let additions: Int
    let deletions: Int
    let isBinary: Bool
    let isRenameOrModeOnly: Bool
    let beforeContentHash: String?
    let afterContentHash: String?
}

enum AIChangeSetStatus: String, Codable, Hashable, Sendable {
    case collecting
    case ready
    case reverted
    case failed
    case notRevertable = "not_revertable"
}

enum AIChangeSetSource: String, Codable, Hashable, Sendable {
    case turnDiff = "turnDiff"
    case workspaceCheckpoint = "workspaceCheckpoint"
    case fileChangeFallback = "fileChangeFallback"
}

struct AIRevertMetadata: Codable, Hashable, Sendable {
    var revertedAt: Date?
    var revertAttemptedAt: Date?
    var lastRevertError: String?

    init(
        revertedAt: Date? = nil,
        revertAttemptedAt: Date? = nil,
        lastRevertError: String? = nil
    ) {
        self.revertedAt = revertedAt
        self.revertAttemptedAt = revertAttemptedAt
        self.lastRevertError = lastRevertError
    }
}

struct AIPatchBatch: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let createdAt: Date
    let source: AIChangeSetSource
    let forwardUnifiedPatch: String
    let patchHash: String
    let fileChanges: [AIFileChange]
    let unsupportedReasons: [String]

    init(
        id: String = UUID().uuidString,
        createdAt: Date = Date(),
        source: AIChangeSetSource = .fileChangeFallback,
        forwardUnifiedPatch: String,
        patchHash: String,
        fileChanges: [AIFileChange],
        unsupportedReasons: [String]
    ) {
        self.id = id
        self.createdAt = createdAt
        self.source = source
        self.forwardUnifiedPatch = forwardUnifiedPatch
        self.patchHash = patchHash
        self.fileChanges = fileChanges
        self.unsupportedReasons = unsupportedReasons
    }
}

struct AIChangeSet: Identifiable, Codable, Hashable, Sendable {
    let id: String
    var repoRoot: String?
    var threadId: String
    var turnId: String
    var assistantMessageId: String?
    var createdAt: Date
    var finalizedAt: Date?
    var status: AIChangeSetStatus
    var source: AIChangeSetSource
    var forwardUnifiedPatch: String
    var inverseUnifiedPatch: String?
    var patchHash: String
    var fileChanges: [AIFileChange]
    var unsupportedReasons: [String]
    var revertMetadata: AIRevertMetadata
    var fallbackPatchCount: Int
    var fallbackPatchBatches: [AIPatchBatch]

    init(
        id: String = UUID().uuidString,
        repoRoot: String? = nil,
        threadId: String,
        turnId: String,
        assistantMessageId: String? = nil,
        createdAt: Date = Date(),
        finalizedAt: Date? = nil,
        status: AIChangeSetStatus = .collecting,
        source: AIChangeSetSource,
        forwardUnifiedPatch: String = "",
        inverseUnifiedPatch: String? = nil,
        patchHash: String = "",
        fileChanges: [AIFileChange] = [],
        unsupportedReasons: [String] = [],
        revertMetadata: AIRevertMetadata = AIRevertMetadata(),
        fallbackPatchCount: Int = 0,
        fallbackPatchBatches: [AIPatchBatch] = []
    ) {
        self.id = id
        self.repoRoot = repoRoot
        self.threadId = threadId
        self.turnId = turnId
        self.assistantMessageId = assistantMessageId
        self.createdAt = createdAt
        self.finalizedAt = finalizedAt
        self.status = status
        self.source = source
        self.forwardUnifiedPatch = forwardUnifiedPatch
        self.inverseUnifiedPatch = inverseUnifiedPatch
        self.patchHash = patchHash
        self.fileChanges = fileChanges
        self.unsupportedReasons = unsupportedReasons
        self.revertMetadata = revertMetadata
        self.fallbackPatchCount = fallbackPatchCount
        self.fallbackPatchBatches = fallbackPatchBatches
    }

    enum CodingKeys: String, CodingKey {
        case id
        case repoRoot
        case threadId
        case turnId
        case assistantMessageId
        case createdAt
        case finalizedAt
        case status
        case source
        case forwardUnifiedPatch
        case inverseUnifiedPatch
        case patchHash
        case fileChanges
        case unsupportedReasons
        case revertMetadata
        case fallbackPatchCount
        case fallbackPatchBatches
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(String.self, forKey: .id)
        self.repoRoot = try container.decodeIfPresent(String.self, forKey: .repoRoot)
        self.threadId = try container.decode(String.self, forKey: .threadId)
        self.turnId = try container.decode(String.self, forKey: .turnId)
        self.assistantMessageId = try container.decodeIfPresent(String.self, forKey: .assistantMessageId)
        self.createdAt = try container.decode(Date.self, forKey: .createdAt)
        self.finalizedAt = try container.decodeIfPresent(Date.self, forKey: .finalizedAt)
        self.status = try container.decode(AIChangeSetStatus.self, forKey: .status)
        self.source = try container.decode(AIChangeSetSource.self, forKey: .source)
        self.forwardUnifiedPatch = try container.decode(String.self, forKey: .forwardUnifiedPatch)
        self.inverseUnifiedPatch = try container.decodeIfPresent(String.self, forKey: .inverseUnifiedPatch)
        self.patchHash = try container.decode(String.self, forKey: .patchHash)
        self.fileChanges = try container.decode([AIFileChange].self, forKey: .fileChanges)
        self.unsupportedReasons = try container.decode([String].self, forKey: .unsupportedReasons)
        self.revertMetadata = try container.decode(AIRevertMetadata.self, forKey: .revertMetadata)
        self.fallbackPatchCount = try container.decodeIfPresent(Int.self, forKey: .fallbackPatchCount) ?? 0
        // Older ledgers predate ordered fallback batches; keep them readable and let single-patch state stand.
        self.fallbackPatchBatches = try container.decodeIfPresent([AIPatchBatch].self, forKey: .fallbackPatchBatches) ?? []
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encodeIfPresent(repoRoot, forKey: .repoRoot)
        try container.encode(threadId, forKey: .threadId)
        try container.encode(turnId, forKey: .turnId)
        try container.encodeIfPresent(assistantMessageId, forKey: .assistantMessageId)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encodeIfPresent(finalizedAt, forKey: .finalizedAt)
        try container.encode(status, forKey: .status)
        try container.encode(source, forKey: .source)
        try container.encode(forwardUnifiedPatch, forKey: .forwardUnifiedPatch)
        try container.encodeIfPresent(inverseUnifiedPatch, forKey: .inverseUnifiedPatch)
        try container.encode(patchHash, forKey: .patchHash)
        try container.encode(fileChanges, forKey: .fileChanges)
        try container.encode(unsupportedReasons, forKey: .unsupportedReasons)
        try container.encode(revertMetadata, forKey: .revertMetadata)
        try container.encode(fallbackPatchCount, forKey: .fallbackPatchCount)
        try container.encode(fallbackPatchBatches, forKey: .fallbackPatchBatches)
    }
}

struct RevertConflict: Codable, Hashable, Sendable {
    let path: String
    let message: String
}

struct RevertPreviewResult: Sendable, Hashable {
    let canRevert: Bool
    let affectedFiles: [String]
    let conflicts: [RevertConflict]
    let unsupportedReasons: [String]
    let stagedFiles: [String]

    init(
        canRevert: Bool,
        affectedFiles: [String],
        conflicts: [RevertConflict],
        unsupportedReasons: [String],
        stagedFiles: [String]
    ) {
        self.canRevert = canRevert
        self.affectedFiles = affectedFiles
        self.conflicts = conflicts
        self.unsupportedReasons = unsupportedReasons
        self.stagedFiles = stagedFiles
    }

    init(from json: [String: JSONValue]) {
        self.canRevert = json["canRevert"]?.boolValue ?? false
        self.affectedFiles = json["affectedFiles"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.conflicts = json["conflicts"]?.arrayValue?.compactMap { value in
            guard let object = value.objectValue else { return nil }
            return RevertConflict(
                path: object["path"]?.stringValue ?? "unknown",
                message: object["message"]?.stringValue ?? "Patch conflict."
            )
        } ?? []
        self.unsupportedReasons = json["unsupportedReasons"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.stagedFiles = json["stagedFiles"]?.arrayValue?.compactMap(\.stringValue) ?? []
    }
}

struct RevertApplyResult: Sendable {
    let success: Bool
    let revertedFiles: [String]
    let conflicts: [RevertConflict]
    let unsupportedReasons: [String]
    let stagedFiles: [String]
    let status: GitRepoSyncResult?

    init(
        success: Bool,
        revertedFiles: [String],
        conflicts: [RevertConflict],
        unsupportedReasons: [String],
        stagedFiles: [String],
        status: GitRepoSyncResult?
    ) {
        self.success = success
        self.revertedFiles = revertedFiles
        self.conflicts = conflicts
        self.unsupportedReasons = unsupportedReasons
        self.stagedFiles = stagedFiles
        self.status = status
    }

    init(from json: [String: JSONValue]) {
        self.success = json["success"]?.boolValue ?? false
        self.revertedFiles = json["revertedFiles"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.conflicts = json["conflicts"]?.arrayValue?.compactMap { value in
            guard let object = value.objectValue else { return nil }
            return RevertConflict(
                path: object["path"]?.stringValue ?? "unknown",
                message: object["message"]?.stringValue ?? "Patch conflict."
            )
        } ?? []
        self.unsupportedReasons = json["unsupportedReasons"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.stagedFiles = json["stagedFiles"]?.arrayValue?.compactMap(\.stringValue) ?? []
        if let statusObject = json["status"]?.objectValue {
            self.status = GitRepoSyncResult(from: statusObject)
        } else {
            self.status = nil
        }
    }
}

enum AssistantRevertRiskLevel: String, Equatable, Hashable, Sendable {
    case safe
    case warning
    case blocked
}

struct AssistantRevertPresentation: Equatable, Hashable, Sendable {
    let title: String
    let isEnabled: Bool
    let helperText: String?
    let riskLevel: AssistantRevertRiskLevel
    let warningText: String?
    let overlappingFiles: [String]

    init(
        title: String,
        isEnabled: Bool,
        helperText: String?,
        riskLevel: AssistantRevertRiskLevel = .safe,
        warningText: String? = nil,
        overlappingFiles: [String] = []
    ) {
        self.title = title
        self.isEnabled = isEnabled
        self.helperText = helperText
        self.riskLevel = riskLevel
        self.warningText = warningText
        self.overlappingFiles = overlappingFiles
    }
}
