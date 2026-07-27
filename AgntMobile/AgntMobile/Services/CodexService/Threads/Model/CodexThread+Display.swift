// FILE: CodexThread+Display.swift
// Purpose: Provides user-facing thread titles, subagent labels, and project grouping display helpers.
// Layer: Model
// Exports: CodexThread display helpers
// Depends on: Foundation, CodexThread

import Foundation

extension CodexThread {
    static let defaultDisplayTitle = "New Thread"
    static let noProjectDisplayName = "No Project"
    static let noProjectGroupKey = "__no_project__"

    // Old rollouts may still persist "Conversation", so treat both labels as the same placeholder.
    static func isGenericPlaceholderTitle(_ value: String?) -> Bool {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return false
        }

        return ["Conversation", defaultDisplayTitle].contains {
            trimmed.localizedCaseInsensitiveCompare($0) == .orderedSame
        }
    }

    var displayTitle: String {
        let cleanedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanedName = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanedAgentLabel = agentDisplayLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanedPreview = preview?.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveTitle = Self.isGenericPlaceholderTitle(cleanedTitle) ? nil : cleanedTitle

        // Prefer explicit thread name (AI/user rename) over server title fallback.
        if let cleanedName, !cleanedName.isEmpty {
            return cleanedName
        }

        if let cleanedAgentLabel, !cleanedAgentLabel.isEmpty {
            if cleanedTitle == nil || Self.isGenericPlaceholderTitle(cleanedTitle) {
                return cleanedAgentLabel
            }
        }

        guard let effectiveTitle, !effectiveTitle.isEmpty else {
            if let cleanedPreview, !cleanedPreview.isEmpty {
                let firstCharacter = cleanedPreview.prefix(1).uppercased()
                let remainingCharacters = cleanedPreview.dropFirst()
                return firstCharacter + remainingCharacters
            }

            return Self.defaultDisplayTitle
        }

        return effectiveTitle
    }

    var isSubagent: Bool {
        parentThreadId != nil
    }

    // App-server exposes the rollout session identifier as Thread.id.
    var sessionId: String {
        id
    }

    // Fork badges use ancestry rather than cwd heuristics so local/worktree routing stays independent.
    var isForkedThread: Bool {
        forkedFromThreadId != nil
    }

    var automationSourceLabel: String? {
        guard let source = threadSource?.trimmingCharacters(in: .whitespacesAndNewlines),
              !source.isEmpty,
              source.localizedCaseInsensitiveCompare("user") != .orderedSame else {
            return nil
        }

        return source
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { word in
                word.prefix(1).uppercased() + String(word.dropFirst())
            }
            .joined(separator: " ")
    }

    var preferredSubagentLabel: String? {
        guard isSubagent else { return nil }

        if let agentDisplayLabel {
            return agentDisplayLabel
        }

        for candidate in [name, title] {
            guard let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !trimmed.isEmpty,
                  !Self.isGenericPlaceholderTitle(trimmed) else {
                continue
            }
            return trimmed
        }

        return nil
    }

    var derivedSubagentIdentity: (nickname: String?, role: String?)? {
        guard let label = preferredSubagentLabel else {
            return nil
        }

        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        guard trimmed.hasSuffix("]"),
              let openBracket = trimmed.lastIndex(of: "[") else {
            return (nickname: trimmed, role: nil)
        }

        let nickname = String(trimmed[..<openBracket]).trimmingCharacters(in: .whitespacesAndNewlines)
        let roleStart = trimmed.index(after: openBracket)
        let roleEnd = trimmed.index(before: trimmed.endIndex)
        let role = String(trimmed[roleStart..<roleEnd]).trimmingCharacters(in: .whitespacesAndNewlines)

        return (
            nickname: nickname.isEmpty ? nil : nickname,
            role: role.isEmpty ? nil : role
        )
    }

    var agentDisplayLabel: String? {
        let nickname = Self.sanitizedAgentIdentity(agentNickname) ?? ""
        let role = Self.sanitizedAgentIdentity(agentRole) ?? ""

        if !nickname.isEmpty && !role.isEmpty {
            return "\(nickname) [\(role)]"
        }
        if !nickname.isEmpty {
            return nickname
        }
        if !role.isEmpty {
            return role.capitalized
        }
        return nil
    }

    var modelDisplayLabel: String? {
        if let provider = modelProvider?.trimmingCharacters(in: .whitespacesAndNewlines), !provider.isEmpty {
            return provider
        }
        if let model = model?.trimmingCharacters(in: .whitespacesAndNewlines), !model.isEmpty {
            return model
        }
        return nil
    }

    // Normalized absolute project path used for stable grouping.
    var normalizedProjectPath: String? {
        Self.normalizeProjectPath(cwd)
    }

    var normalizedWorktreeOriginPath: String? {
        Self.normalizeProjectPath(worktreeOriginPath)
    }

    // Best-effort repo root for project-scoped bridge features like git actions.
    var gitWorkingDirectory: String? {
        if let normalizedProjectPath {
            return normalizedProjectPath
        }
        return nil
    }

    // Stable key for grouping threads by project.
    var projectKey: String {
        normalizedProjectPath ?? Self.noProjectGroupKey
    }

    var projectGroupPath: String? {
        normalizedWorktreeOriginPath ?? normalizedProjectPath
    }

    var projectGroupKey: String {
        projectGroupPath ?? Self.noProjectGroupKey
    }

    // User-facing project label shown in the sidebar section header.
    var projectDisplayName: String {
        Self.projectDisplayLabel(for: normalizedProjectPath)
    }

    // Reuses the same worktree detection across the sidebar, toolbar, and composer affordances.
    var isManagedWorktreeProject: Bool {
        Self.isManagedWorktreePath(normalizedProjectPath)
    }

    // Distinguishes Codex-managed worktrees from the main repo in compact sidebar UIs.
    static func projectDisplayLabel(for normalizedProjectPath: String?) -> String {
        guard let normalizedProjectPath else {
            return noProjectDisplayName
        }

        let baseLabel = projectBaseDisplayName(for: normalizedProjectPath)
        guard let worktreeToken = codexManagedWorktreeDisplayToken(for: normalizedProjectPath) else {
            return baseLabel
        }

        return "\(baseLabel) \(worktreeToken)"
    }

    static func projectIconSystemName(for normalizedProjectPath: String?) -> String {
        guard let normalizedProjectPath else {
            return "bubble.left.and.bubble.right"
        }

        return isManagedWorktreePath(normalizedProjectPath) ? "arrow.triangle.branch" : "folder"
    }

    static func isManagedWorktreePath(_ normalizedProjectPath: String?) -> Bool {
        guard let normalizedProjectPath else {
            return false
        }
        return codexManagedWorktreeToken(for: normalizedProjectPath) != nil
    }

    // Shared path gate for every flow that needs to decide whether a cwd represents a real local project.
    static func normalizedFilesystemProjectPath(_ value: String?) -> String? {
        normalizeProjectPath(value)
    }

    // Git writes are repo-scoped, so every live root chat bound to a real cwd can expose them.
    // Do not tie this to sidebar/thread-list hydration; background refreshes would make
    // the toolbar disappear even though the active repo has not changed.
    static func gitControlsVisible(
        for thread: CodexThread,
        workingDirectory rawWorkingDirectory: String?,
        isConnected: Bool
    ) -> Bool {
        guard isConnected,
              thread.syncState == .live,
              thread.parentThreadId == nil,
              normalizedFilesystemProjectPath(rawWorkingDirectory) != nil else {
            return false
        }

        return true
    }
}

private extension CodexThread {
    static func sanitizedAgentIdentity(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let lowered = trimmed.lowercased()
        if lowered == "collabagenttoolcall" || lowered == "collabtoolcall" {
            return nil
        }

        return trimmed
    }

    static func projectBaseDisplayName(for normalizedProjectPath: String) -> String {
        let lastComponent = (normalizedProjectPath as NSString).lastPathComponent
        if !lastComponent.isEmpty, lastComponent != "/" {
            return lastComponent
        }

        return normalizedProjectPath
    }

    static func codexManagedWorktreeDisplayToken(for normalizedProjectPath: String) -> String? {
        guard let token = codexManagedWorktreeToken(for: normalizedProjectPath) else {
            return nil
        }

        return "[\(token)]"
    }
}
