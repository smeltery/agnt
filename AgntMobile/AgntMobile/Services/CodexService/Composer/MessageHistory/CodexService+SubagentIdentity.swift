// FILE: CodexService+SubagentIdentity.swift
// Purpose: Tracks subagent child-thread placeholders and display identity.
// Layer: Service extension
// Exports: CodexService subagent identity helpers
// Depends on: Foundation, CodexThread, CodexSubagentAction

import Foundation

extension CodexService {
    // Promotes subagents to first-class child threads so selection, sync, and sidebar rendering stay native.
    func registerSubagentThreads(action: CodexSubagentAction, parentThreadId: String) {
        guard !parentThreadId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }

        let parentThread = thread(for: parentThreadId)
        var unresolvedChildThreadIDs: [String] = []
        upsertSubagentIdentity(action: action)

        for agent in action.agentRows {
            let childThreadId = agent.threadId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !childThreadId.isEmpty, childThreadId != parentThreadId else {
                continue
            }

            let existing = thread(for: childThreadId)
            let resolvedIdentity = resolvedSubagentIdentity(
                threadId: childThreadId,
                agentId: agent.agentId
            )
            let placeholderTimestamp = existing?.updatedAt
                ?? existing?.createdAt
                ?? parentThread?.updatedAt
                ?? parentThread?.createdAt
                ?? Date()
            let placeholder = CodexThread(
                id: childThreadId,
                title: nil,
                name: nil,
                preview: existing?.preview,
                createdAt: existing?.createdAt ?? placeholderTimestamp,
                updatedAt: existing?.updatedAt ?? placeholderTimestamp,
                cwd: existing?.cwd ?? parentThread?.cwd,
                metadata: existing?.metadata,
                parentThreadId: parentThreadId,
                agentId: agent.agentId,
                agentNickname: existing?.agentNickname ?? agent.nickname ?? resolvedIdentity?.nickname,
                agentRole: existing?.agentRole ?? agent.role ?? resolvedIdentity?.role,
                // Requested spawn-model hints stay on the timeline row until a real child-thread
                // payload arrives; avoid persisting them as canonical thread metadata.
                model: existing?.model ?? (agent.modelIsRequestedHint ? nil : agent.model),
                modelProvider: existing?.modelProvider ?? (agent.modelIsRequestedHint ? nil : agent.model),
                syncState: existing?.syncState ?? parentThread?.syncState ?? .live
            )
            upsertThread(placeholder)

            let hasResolvedIdentity = placeholder.preferredSubagentLabel != nil
                || normalizedIdentifier(placeholder.agentNickname) != nil
                || normalizedIdentifier(placeholder.agentRole) != nil
            if !hasResolvedIdentity {
                unresolvedChildThreadIDs.append(childThreadId)
            }
        }

        // Starts child-thread hydration as soon as placeholders exist so sidebar/timeline
        // labels can upgrade from ids to names before the card itself appears on screen.
        if !unresolvedChildThreadIDs.isEmpty {
            let threadIDs = unresolvedChildThreadIDs
            Task {
                await loadSubagentThreadMetadataIfNeeded(threadIds: threadIDs)
            }
        }
    }

    // Rebuilds child thread placeholders from persisted timeline rows after reconnect or cold launch.
    func registerSubagentThreads(from messages: [CodexMessage], parentThreadId: String) {
        for action in messages.compactMap(\.subagentAction) {
            registerSubagentThreads(action: action, parentThreadId: parentThreadId)
        }
    }

    func rebuildSubagentIdentityDirectory() {
        subagentIdentityByThreadID = [:]
        subagentIdentityByAgentID = [:]

        for thread in threads {
            let derivedIdentity = thread.derivedSubagentIdentity
            upsertSubagentIdentity(
                threadId: thread.id,
                agentId: thread.agentId,
                nickname: thread.agentNickname ?? derivedIdentity?.nickname,
                role: thread.agentRole ?? derivedIdentity?.role,
                incrementVersion: false
            )
        }

        for actions in messagesByThread.values.flatMap(\.lazy).compactMap(\.subagentAction) {
            upsertSubagentIdentity(action: actions, incrementVersion: false)
        }

        subagentIdentityVersion &+= 1
    }

    func refreshSubagentIdentityDirectoryFromThreads() {
        var didChange = false
        for thread in threads {
            let derivedIdentity = thread.derivedSubagentIdentity
            if upsertSubagentIdentity(
                threadId: thread.id,
                agentId: thread.agentId,
                nickname: thread.agentNickname ?? derivedIdentity?.nickname,
                role: thread.agentRole ?? derivedIdentity?.role,
                incrementVersion: false
            ) {
                didChange = true
            }
        }
        if didChange {
            subagentIdentityVersion &+= 1
        }
    }

    func upsertSubagentIdentity(action: CodexSubagentAction, incrementVersion: Bool = true) {
        for agent in action.agentRows {
            upsertSubagentIdentity(
                threadId: agent.threadId,
                agentId: agent.agentId,
                nickname: agent.nickname,
                role: agent.role,
                incrementVersion: incrementVersion
            )
        }
    }

    func resolvedSubagentIdentity(threadId: String?, agentId: String?) -> CodexSubagentIdentityEntry? {
        let normalizedThreadId = normalizedIdentifier(threadId)
        let normalizedAgentId = normalizedIdentifier(agentId)

        let threadEntry = normalizedThreadId.flatMap { subagentIdentityByThreadID[$0] }
        let agentEntry = normalizedAgentId.flatMap { subagentIdentityByAgentID[$0] }

        let merged = CodexSubagentIdentityEntry(
            threadId: threadEntry?.threadId ?? agentEntry?.threadId ?? normalizedThreadId,
            agentId: threadEntry?.agentId ?? agentEntry?.agentId ?? normalizedAgentId,
            nickname: threadEntry?.nickname ?? agentEntry?.nickname,
            role: threadEntry?.role ?? agentEntry?.role
        )

        return merged.hasMetadata ? merged : nil
    }

    func resolvedSubagentDisplayLabel(threadId: String?, agentId: String?) -> String? {
        if let normalizedThreadId = normalizedIdentifier(threadId),
           let thread = thread(for: normalizedThreadId),
           let preferredLabel = thread.preferredSubagentLabel {
            return preferredLabel
        }

        let resolved = resolvedSubagentIdentity(threadId: threadId, agentId: agentId)
        let nickname = normalizedIdentifier(resolved?.nickname)
        let role = normalizedIdentifier(resolved?.role)

        if let nickname, let role {
            return "\(nickname) [\(role)]"
        }
        if let nickname {
            return nickname
        }
        if let role {
            return role.capitalized
        }

        return nil
    }

    // Loads child-thread metadata for sidebar/timeline rows without suppressing future retries
    // while the thread is still being materialized by the runtime.
    func loadSubagentThreadMetadataIfNeeded(threadId: String) async {
        await loadSubagentThreadMetadataIfNeeded(threadIds: [threadId])
    }

    // Batches visible child-thread metadata loads so expanding a tree does not trigger
    // one independent refresh/re-render cycle per row.
    func loadSubagentThreadMetadataIfNeeded(threadIds: [String]) async {
        let normalizedThreadIds = uniqueNormalizedThreadIDs(threadIds)
        guard !normalizedThreadIds.isEmpty else {
            return
        }

        var didAttemptLoad = false
        for normalizedThreadId in normalizedThreadIds {
            if await loadSingleSubagentThreadMetadataIfNeeded(threadId: normalizedThreadId) {
                didAttemptLoad = true
            }
        }

        if didAttemptLoad {
            refreshSubagentIdentityDirectoryFromThreads()
        }
    }

    private func loadSingleSubagentThreadMetadataIfNeeded(threadId: String) async -> Bool {
        guard !subagentMetadataLoadingThreadIDs.contains(threadId) else {
            return false
        }

        let existingThread = thread(for: threadId)
        let hasResolvedIdentity = existingThread?.preferredSubagentLabel != nil
            || normalizedIdentifier(existingThread?.agentNickname) != nil
            || normalizedIdentifier(existingThread?.agentRole) != nil
        guard !hasResolvedIdentity else {
            return false
        }

        subagentMetadataLoadingThreadIDs.insert(threadId)
        defer { subagentMetadataLoadingThreadIDs.remove(threadId) }

        let shouldForceRefresh = hydratedThreadIDs.contains(threadId)
        _ = try? await loadThreadHistoryIfNeeded(
            threadId: threadId,
            forceRefresh: shouldForceRefresh,
            markHydratedWhenNotMaterialized: false
        )
        return true
    }

    private func uniqueNormalizedThreadIDs(_ threadIds: [String]) -> [String] {
        var seen: Set<String> = []
        var result: [String] = []

        for threadId in threadIds {
            guard let normalizedThreadId = normalizedIdentifier(threadId),
                  !seen.contains(normalizedThreadId) else {
                continue
            }
            seen.insert(normalizedThreadId)
            result.append(normalizedThreadId)
        }

        return result
    }

    @discardableResult
    func upsertSubagentIdentity(
        threadId: String?,
        agentId: String?,
        nickname: String?,
        role: String?,
        incrementVersion: Bool = true
    ) -> Bool {
        let normalizedThreadId = normalizedIdentifier(threadId)
        let normalizedAgentId = normalizedIdentifier(agentId)
        let normalizedNickname = normalizedIdentifier(nickname)
        let normalizedRole = normalizedIdentifier(role)

        guard normalizedThreadId != nil || normalizedAgentId != nil || normalizedNickname != nil || normalizedRole != nil else {
            return false
        }

        let threadEntry = normalizedThreadId.flatMap { subagentIdentityByThreadID[$0] }
        let agentEntry = normalizedAgentId.flatMap { subagentIdentityByAgentID[$0] }
        let merged = CodexSubagentIdentityEntry(
            threadId: normalizedThreadId ?? threadEntry?.threadId ?? agentEntry?.threadId,
            agentId: normalizedAgentId ?? threadEntry?.agentId ?? agentEntry?.agentId,
            nickname: normalizedNickname ?? threadEntry?.nickname ?? agentEntry?.nickname,
            role: normalizedRole ?? threadEntry?.role ?? agentEntry?.role
        )

        guard merged.hasMetadata else { return false }

        var didChange = false
        if let normalizedThreadId, subagentIdentityByThreadID[normalizedThreadId] != merged {
            subagentIdentityByThreadID[normalizedThreadId] = merged
            didChange = true
        }
        if let normalizedAgentId, subagentIdentityByAgentID[normalizedAgentId] != merged {
            subagentIdentityByAgentID[normalizedAgentId] = merged
            didChange = true
        }
        if let linkedThreadId = merged.threadId,
           let linkedAgentId = merged.agentId {
            if subagentIdentityByThreadID[linkedThreadId] != merged {
                subagentIdentityByThreadID[linkedThreadId] = merged
                didChange = true
            }
            if subagentIdentityByAgentID[linkedAgentId] != merged {
                subagentIdentityByAgentID[linkedAgentId] = merged
                didChange = true
            }
        }

        if incrementVersion, didChange {
            subagentIdentityVersion &+= 1
        }
        return didChange
    }

    // Reuses previously seen spawn metadata so later wait/sendInput events can still show real agent names.
    func resolvedSubagentPresentation(
        _ presentation: CodexSubagentThreadPresentation,
        parentThreadId: String
    ) -> CodexSubagentThreadPresentation {
        let normalizedParentThreadId = normalizedIdentifier(parentThreadId) ?? parentThreadId
        let normalizedThreadId = normalizedIdentifier(presentation.threadId)
        let normalizedAgentId = normalizedIdentifier(presentation.agentId)

        var resolvedThreadId = normalizedThreadId
        var resolvedAgentId = normalizedAgentId
        var resolvedNickname = normalizedIdentifier(presentation.nickname)
        var resolvedRole = normalizedIdentifier(presentation.role)
        var resolvedModel = normalizedIdentifier(presentation.model)
        var resolvedModelIsRequestedHint = presentation.modelIsRequestedHint
        var resolvedPrompt = normalizedIdentifier(presentation.prompt)

        if let directoryIdentity = resolvedSubagentIdentity(threadId: normalizedThreadId, agentId: normalizedAgentId) {
            resolvedThreadId = directoryIdentity.threadId ?? resolvedThreadId
            resolvedAgentId = directoryIdentity.agentId ?? resolvedAgentId
            resolvedNickname = directoryIdentity.nickname ?? resolvedNickname
            resolvedRole = directoryIdentity.role ?? resolvedRole
        }

        func mergeThreadMetadata(_ thread: CodexThread?) {
            guard let thread else { return }
            if resolvedThreadId == nil { resolvedThreadId = normalizedIdentifier(thread.id) }
            if let threadAgentId = normalizedIdentifier(thread.agentId) {
                resolvedAgentId = threadAgentId
            }
            if let threadNickname = normalizedIdentifier(thread.agentNickname) {
                resolvedNickname = threadNickname
            }
            if let threadRole = normalizedIdentifier(thread.agentRole) {
                resolvedRole = threadRole
            }
            if let derivedIdentity = thread.derivedSubagentIdentity {
                if let derivedNickname = normalizedIdentifier(derivedIdentity.nickname) {
                    resolvedNickname = derivedNickname
                }
                if let derivedRole = normalizedIdentifier(derivedIdentity.role) {
                    resolvedRole = derivedRole
                }
            }
            if let threadModel = normalizedIdentifier(thread.modelDisplayLabel) {
                resolvedModel = threadModel
                resolvedModelIsRequestedHint = false
            }
        }

        if let normalizedThreadId {
            mergeThreadMetadata(thread(for: normalizedThreadId))
        }

        let lookupIdentifiers = Set([normalizedThreadId, normalizedAgentId].compactMap { $0 })
        if !lookupIdentifiers.isEmpty {
            let parentMessages = messagesByThread[normalizedParentThreadId] ?? []

            outer: for message in parentMessages.reversed() {
                guard let action = message.subagentAction else { continue }
                for candidate in action.agentRows.reversed() {
                    let candidateThreadId = normalizedIdentifier(candidate.threadId)
                    let candidateAgentId = normalizedIdentifier(candidate.agentId)
                    let matchedIdentifiers = Set([candidateThreadId, candidateAgentId].compactMap { $0 })
                    guard !lookupIdentifiers.isDisjoint(with: matchedIdentifiers) else {
                        continue
                    }

                    if resolvedThreadId == nil, let candidateThreadId {
                        resolvedThreadId = candidateThreadId
                    }
                    if resolvedAgentId == nil, let candidateAgentId {
                        resolvedAgentId = candidateAgentId
                    }
                    if resolvedNickname == nil {
                        resolvedNickname = normalizedIdentifier(candidate.nickname)
                    }
                    if resolvedRole == nil {
                        resolvedRole = normalizedIdentifier(candidate.role)
                    }
                    if resolvedModel == nil {
                        resolvedModel = normalizedIdentifier(candidate.model)
                        resolvedModelIsRequestedHint = candidate.modelIsRequestedHint
                    }
                    if resolvedPrompt == nil {
                        resolvedPrompt = normalizedIdentifier(candidate.prompt)
                    }

                    upsertSubagentIdentity(
                        threadId: candidateThreadId,
                        agentId: candidateAgentId,
                        nickname: candidate.nickname,
                        role: candidate.role,
                        incrementVersion: false
                    )

                    if let candidateThreadId {
                        mergeThreadMetadata(thread(for: candidateThreadId))
                    }
                    break outer
                }
            }
        }

        let finalThreadId = resolvedThreadId ?? normalizedThreadId ?? presentation.threadId
        return CodexSubagentThreadPresentation(
            threadId: finalThreadId,
            agentId: resolvedAgentId,
            nickname: resolvedNickname,
            role: resolvedRole,
            model: resolvedModel,
            modelIsRequestedHint: resolvedModelIsRequestedHint,
            prompt: resolvedPrompt,
            fallbackStatus: presentation.fallbackStatus,
            fallbackMessage: presentation.fallbackMessage
        )
    }

}
