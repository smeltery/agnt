// FILE: CodexThread.swift
// Purpose: Represents a Codex conversation thread returned by thread/list and related events,
//   including native subagent identity metadata used by the sidebar and parent-child navigation.
// Layer: Model
// Exports: CodexThread
// Depends on: JSONValue

import Foundation

enum CodexTimestampParser {
    private static let iso8601Formatters: [ISO8601DateFormatter] = {
        let withFractions = ISO8601DateFormatter()
        withFractions.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]

        return [withFractions, standard]
    }()

    static func parseString(_ value: String?) -> Date? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }

        if let numeric = Double(trimmed) {
            return decodeUnixTimestamp(numeric)
        }

        for formatter in iso8601Formatters {
            if let date = formatter.date(from: trimmed) {
                return date
            }
        }

        return nil
    }

    // Accepts second, millisecond, microsecond, and nanosecond Unix timestamps.
    static func decodeUnixTimestamp(_ rawValue: Double) -> Date {
        let absoluteValue = abs(rawValue)
        let secondsValue: Double

        switch absoluteValue {
        case 1_000_000_000_000_000_000...:
            secondsValue = rawValue / 1_000_000_000
        case 1_000_000_000_000_000...:
            secondsValue = rawValue / 1_000_000
        case 10_000_000_000...:
            secondsValue = rawValue / 1_000
        default:
            secondsValue = rawValue
        }

        return Date(timeIntervalSince1970: secondsValue)
    }

    // Filters out placeholder dates so local optimistic timestamps are not replaced by epoch fallbacks.
    nonisolated static func isTrustworthyServerDate(_ date: Date) -> Bool {
        date.timeIntervalSince1970 >= 946_684_800 // 2000-01-01T00:00:00Z
    }
}

enum CodexThreadSyncState: String, Codable, Hashable, Sendable {
    case live
    case archivedLocal
}

struct CodexThread: Identifiable, Codable, Hashable, Sendable {
    let id: String
    var title: String?
    var name: String?
    var preview: String?
    var createdAt: Date?
    var updatedAt: Date?
    var cwd: String?
    var worktreeOriginPath: String?
    var metadata: [String: JSONValue]?
    var forkedFromThreadId: String?
    var threadSource: String?
    var parentThreadId: String?
    var agentId: String?
    var agentNickname: String?
    var agentRole: String?
    var model: String?
    var runtimeSettings: CodexRuntimeSettings? = nil
    var modelProvider: String?
    var ephemeral: Bool
    var syncState: CodexThreadSyncState

    // --- Public initializer ---------------------------------------------------

    init(
        id: String,
        title: String? = nil,
        name: String? = nil,
        preview: String? = nil,
        createdAt: Date? = nil,
        updatedAt: Date? = nil,
        cwd: String? = nil,
        worktreeOriginPath: String? = nil,
        metadata: [String: JSONValue]? = nil,
        forkedFromThreadId: String? = nil,
        threadSource: String? = nil,
        parentThreadId: String? = nil,
        agentId: String? = nil,
        agentNickname: String? = nil,
        agentRole: String? = nil,
        model: String? = nil,
        modelProvider: String? = nil,
        ephemeral: Bool = false,
        syncState: CodexThreadSyncState = .live
    ) {
        self.id = id
        self.title = title
        self.name = name
        self.preview = preview
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.cwd = Self.normalizeProjectPath(cwd)
        self.worktreeOriginPath = Self.normalizeProjectPath(worktreeOriginPath)
        self.metadata = metadata
        self.forkedFromThreadId = Self.normalizeIdentifier(forkedFromThreadId)
        self.threadSource = Self.normalizeIdentifier(threadSource)
        self.parentThreadId = Self.normalizeIdentifier(parentThreadId)
        self.agentId = Self.normalizeIdentifier(agentId)
        self.agentNickname = Self.normalizeIdentifier(agentNickname)
        self.agentRole = Self.normalizeIdentifier(agentRole)
        self.model = Self.normalizeIdentifier(model)
        self.modelProvider = Self.normalizeIdentifier(modelProvider)
        self.ephemeral = ephemeral
        self.syncState = syncState
    }

    // --- Codable keys ---------------------------------------------------------

    private enum CodingKeys: String, CodingKey {
        case id
        case title
        case name
        case preview
        case createdAt
        case createdAtSnake = "created_at"
        case updatedAt
        case updatedAtSnake = "updated_at"
        case cwd
        case cwdSnake = "current_working_directory"
        case cwdWorkingDirectory = "working_directory"
        case worktreeOriginPath
        case worktreeOriginPathSnake = "worktree_origin_path"
        case metadata
        case forkedFromThreadId
        case forkedFromId = "forkedFromId"
        case forkedFromThreadIdSnake = "forked_from_thread_id"
        case forkedFromIdSnake = "forked_from_id"
        case threadSource
        case threadSourceSnake = "thread_source"
        case parentThreadId
        case parentThreadIdSnake = "parent_thread_id"
        case agentId
        case agentIdSnake = "agent_id"
        case agentNickname
        case agentNicknameSnake = "agent_nickname"
        case agentRole
        case agentRoleSnake = "agent_role"
        case model
        case runtimeSettings
        case modelProvider
        case modelProviderSnake = "model_provider"
        case ephemeral
        case syncState
    }

    // --- Custom decoding ------------------------------------------------------

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        id = try container.decode(String.self, forKey: .id)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        preview = try container.decodeIfPresent(String.self, forKey: .preview)
        createdAt = try Self.decodeDateIfPresent(from: container, keys: [.createdAt, .createdAtSnake])
        updatedAt = try Self.decodeDateIfPresent(from: container, keys: [.updatedAt, .updatedAtSnake])
        cwd = Self.decodeStringIfPresent(from: container, keys: [.cwd, .cwdSnake, .cwdWorkingDirectory])
        metadata = try container.decodeIfPresent([String: JSONValue].self, forKey: .metadata)
        worktreeOriginPath = Self.decodeThreadPath(
            from: container,
            metadata: metadata,
            keys: [.worktreeOriginPath, .worktreeOriginPathSnake],
            metadataKeys: ["worktreeOriginPath", "worktree_origin_path"]
        )
        forkedFromThreadId = Self.decodeThreadIdentity(
            from: container,
            metadata: metadata,
            keys: [.forkedFromThreadId, .forkedFromId, .forkedFromThreadIdSnake, .forkedFromIdSnake],
            metadataKeys: ["forkedFromThreadId", "forked_from_thread_id", "forkedFromId", "forked_from_id"]
        )
        threadSource = Self.decodeThreadIdentity(
            from: container,
            metadata: metadata,
            keys: [.threadSource, .threadSourceSnake],
            metadataKeys: ["threadSource", "thread_source"]
        )
        parentThreadId = Self.decodeThreadIdentity(
            from: container,
            metadata: metadata,
            keys: [.parentThreadId, .parentThreadIdSnake],
            metadataKeys: ["parentThreadId", "parent_thread_id"]
        )
        agentId = Self.decodeThreadIdentity(
            from: container,
            metadata: metadata,
            keys: [.agentId, .agentIdSnake],
            metadataKeys: ["agentId", "agent_id"]
        )
        agentNickname = Self.decodeThreadIdentity(
            from: container,
            metadata: metadata,
            keys: [.agentNickname, .agentNicknameSnake],
            metadataKeys: ["agentNickname", "agent_nickname", "nickname", "name"]
        )
        agentRole = Self.decodeThreadIdentity(
            from: container,
            metadata: metadata,
            keys: [.agentRole, .agentRoleSnake],
            metadataKeys: ["agentRole", "agent_role", "agentType", "agent_type"]
        )
        runtimeSettings = try container.decodeIfPresent(CodexRuntimeSettings.self, forKey: .runtimeSettings)
        model = Self.decodeThreadIdentity(
            from: container,
            metadata: metadata,
            keys: [.model],
            metadataKeys: ["model", "modelName", "model_name"]
        )
        modelProvider = Self.decodeThreadIdentity(
            from: container,
            metadata: metadata,
            keys: [.modelProvider, .modelProviderSnake],
            metadataKeys: ["modelProvider", "model_provider", "modelProviderId", "model_provider_id"]
        )
        ephemeral = try container.decodeIfPresent(Bool.self, forKey: .ephemeral) ?? false
        syncState = try container.decodeIfPresent(CodexThreadSyncState.self, forKey: .syncState) ?? .live
    }

    // --- Custom encoding ------------------------------------------------------

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(runtimeSettings, forKey: .runtimeSettings)

        try container.encode(id, forKey: .id)
        try container.encodeIfPresent(title, forKey: .title)
        try container.encodeIfPresent(name, forKey: .name)
        try container.encodeIfPresent(preview, forKey: .preview)
        try container.encodeIfPresent(createdAt, forKey: .createdAt)
        try container.encodeIfPresent(updatedAt, forKey: .updatedAt)
        try container.encodeIfPresent(Self.normalizeProjectPath(cwd), forKey: .cwd)
        try container.encodeIfPresent(Self.normalizeProjectPath(worktreeOriginPath), forKey: .worktreeOriginPath)
        try container.encodeIfPresent(metadata, forKey: .metadata)
        try container.encodeIfPresent(Self.normalizeIdentifier(forkedFromThreadId), forKey: .forkedFromThreadId)
        try container.encodeIfPresent(Self.normalizeIdentifier(threadSource), forKey: .threadSource)
        try container.encodeIfPresent(Self.normalizeIdentifier(parentThreadId), forKey: .parentThreadId)
        try container.encodeIfPresent(Self.normalizeIdentifier(agentId), forKey: .agentId)
        try container.encodeIfPresent(Self.normalizeIdentifier(agentNickname), forKey: .agentNickname)
        try container.encodeIfPresent(Self.normalizeIdentifier(agentRole), forKey: .agentRole)
        try container.encodeIfPresent(Self.normalizeIdentifier(model), forKey: .model)
        try container.encodeIfPresent(Self.normalizeIdentifier(modelProvider), forKey: .modelProvider)
        try container.encode(ephemeral, forKey: .ephemeral)
        try container.encode(syncState, forKey: .syncState)
    }
}

extension CodexThread {
    // --- Date parsing ---------------------------------------------------------

    private static func decodeDateIfPresent(
        from container: KeyedDecodingContainer<CodingKeys>,
        keys: [CodingKeys]
    ) throws -> Date? {
        for key in keys {
            if let stringValue = try? container.decodeIfPresent(String.self, forKey: key) {
                if let parsedDate = CodexTimestampParser.parseString(stringValue) {
                    return parsedDate
                }
            }

            if let doubleValue = try? container.decodeIfPresent(Double.self, forKey: key) {
                return CodexTimestampParser.decodeUnixTimestamp(doubleValue)
            }

            if let intValue = try? container.decodeIfPresent(Int64.self, forKey: key) {
                return CodexTimestampParser.decodeUnixTimestamp(Double(intValue))
            }

            // Keep native Date decoding as a final fallback for unexpected formats.
            if let date = try? container.decodeIfPresent(Date.self, forKey: key) {
                return date
            }
        }

        return nil
    }
    private static func decodeStringIfPresent(
        from container: KeyedDecodingContainer<CodingKeys>,
        keys: [CodingKeys]
    ) -> String? {
        for key in keys {
            if let value = try? container.decodeIfPresent(String.self, forKey: key),
               let normalized = normalizeProjectPath(value) {
                return normalized
            }
        }

        return nil
    }

    private static func decodeThreadIdentity(
        from container: KeyedDecodingContainer<CodingKeys>,
        metadata: [String: JSONValue]?,
        keys: [CodingKeys],
        metadataKeys: [String]
    ) -> String? {
        for key in keys {
            if let value = try? container.decodeIfPresent(String.self, forKey: key),
               let normalized = normalizeIdentifier(value) {
                return normalized
            }
        }

        for metadataKey in metadataKeys {
            if let normalized = normalizeIdentifier(metadata?[metadataKey]?.stringValue) {
                return normalized
            }
        }

        return nil
    }

    private static func decodeThreadPath(
        from container: KeyedDecodingContainer<CodingKeys>,
        metadata: [String: JSONValue]?,
        keys: [CodingKeys],
        metadataKeys: [String]
    ) -> String? {
        for key in keys {
            if let value = try? container.decodeIfPresent(String.self, forKey: key),
               let normalized = normalizeProjectPath(value) {
                return normalized
            }
        }

        for metadataKey in metadataKeys {
            if let normalized = normalizeProjectPath(metadata?[metadataKey]?.stringValue) {
                return normalized
            }
        }

        return nil
    }

    private static func normalizeIdentifier(_ value: String?) -> String? {
        guard let value else {
            return nil
        }

        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func normalizeProjectPath(_ value: String?) -> String? {
        guard let value else {
            return nil
        }

        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        if let normalizedRootPath = normalizedFilesystemRootPath(trimmed) {
            return normalizedRootPath
        }

        var normalized = trimmed
        while normalized.hasSuffix("/") {
            normalized.removeLast()
        }

        if normalized.isEmpty {
            return "/"
        }

        guard isLikelyFilesystemPath(normalized) else {
            return nil
        }

        return normalized
    }

    // Preserves valid filesystem roots that would otherwise be mangled by generic trailing-slash trimming.
    private static func normalizedFilesystemRootPath(_ value: String) -> String? {
        if value == "/" {
            return "/"
        }

        if value.first == "~", value.dropFirst().allSatisfy({ $0 == "/" }) {
            return "~/"
        }

        let utf16View = value.utf16
        guard utf16View.count >= 3 else {
            return nil
        }

        let startIndex = utf16View.startIndex
        let first = utf16View[startIndex]
        let second = utf16View[utf16View.index(after: startIndex)]
        let thirdIndex = utf16View.index(startIndex, offsetBy: 2)
        let third = utf16View[thirdIndex]
        let isDriveLetter = (65...90).contains(first) || (97...122).contains(first)
        guard isDriveLetter, second == 58, third == 92 || third == 47 else {
            return nil
        }

        let remainder = value.dropFirst(3)
        guard remainder.allSatisfy({ $0 == "/" || $0 == "\\" }) else {
            return nil
        }

        let drive = UnicodeScalar(first).map(String.init) ?? "C"
        return "\(drive):/"
    }

    // Rejects pseudo-buckets like `server` or `_default` so only real local paths create project groups.
    private static func isLikelyFilesystemPath(_ value: String) -> Bool {
        if value == "/" {
            return true
        }

        if value.hasPrefix("/") || value.hasPrefix("~/") {
            return true
        }

        let utf16View = value.utf16
        guard utf16View.count >= 3 else {
            return false
        }

        let first = utf16View[utf16View.startIndex]
        let second = utf16View[utf16View.index(after: utf16View.startIndex)]
        let third = utf16View[utf16View.index(utf16View.startIndex, offsetBy: 2)]
        let isDriveLetter = (65...90).contains(first) || (97...122).contains(first)
        if isDriveLetter, second == 58, third == 92 || third == 47 {
            return true
        }

        return value.hasPrefix("\\\\")
    }

    static func codexManagedWorktreeToken(for normalizedProjectPath: String) -> String? {
        let components = URL(fileURLWithPath: normalizedProjectPath).standardized.pathComponents
        guard let worktreesIndex = components.firstIndex(of: "worktrees"),
              worktreesIndex > 0,
              components[worktreesIndex - 1] == ".codex" else {
            return nil
        }

        let tokenIndex = components.index(after: worktreesIndex)
        guard components.indices.contains(tokenIndex) else {
            return nil
        }

        let token = components[tokenIndex].trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : token
    }
}
