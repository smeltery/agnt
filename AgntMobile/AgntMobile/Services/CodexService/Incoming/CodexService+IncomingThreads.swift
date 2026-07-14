// FILE: CodexService+IncomingThreads.swift
// Purpose: Incoming thread lifecycle metadata handlers.
// Layer: Service
// Exports: CodexService incoming thread handlers

import Foundation

extension CodexService {
    func handleThreadStarted(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject,
              let threadValue = paramsObject["thread"],
              let thread = decodeModel(CodexThread.self, from: threadValue) else {
            return
        }

        upsertThread(thread, treatAsServerState: true)
        if activeThreadId == nil {
            activeThreadId = thread.id
        }
        requestImmediateSync(threadId: thread.id)
    }

    func handleThreadReplaced(_ paramsObject: IncomingParamsObject?) {
        guard let threadId = extractThreadID(from: paramsObject)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !threadId.isEmpty else {
            return
        }

        projectedTerminalStateByThreadID.removeValue(forKey: threadId)
        pendingCanonicalSourceReplacementThreadIDs.insert(threadId)
        forcedHistoryLoadThreadIDs.insert(threadId)
        markThreadNeedingCanonicalHistoryReconcile(threadId, requestImmediateSync: true)
    }

    func handleThreadNameUpdated(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject else {
            return
        }

        guard let threadId = extractThreadID(from: paramsObject)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !threadId.isEmpty else {
            return
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let renameKeys = ["threadName", "thread_name", "name", "title"]
        let hasExplicitRenameField = hasAnyValue(in: paramsObject, keys: renameKeys)
            || hasAnyValue(in: eventObject, keys: renameKeys)
        let threadName = firstStringValue(in: paramsObject, keys: renameKeys)
            ?? firstStringValue(in: eventObject, keys: renameKeys)
        let normalizedThreadName = normalizedIdentifier(threadName)
        let hasLocalRename = persistedThreadRename(for: threadId) != nil

        if let normalizedThreadName, !normalizedThreadName.isEmpty {
            guard !hasLocalRename else {
                return
            }
            if let existingIndex = threadIndex(for: threadId) {
                threads[existingIndex].title = normalizedThreadName
                threads[existingIndex].name = normalizedThreadName
            } else {
                threads.append(
                    CodexThread(
                        id: threadId,
                        title: normalizedThreadName,
                        name: normalizedThreadName
                    )
                )
            }
            threads = sortThreads(threads)
            requestImmediateSync(threadId: threadId)
            return
        }

        guard hasExplicitRenameField,
              !hasLocalRename,
              let existingIndex = threadIndex(for: threadId) else {
            return
        }

        threads[existingIndex].title = nil
        threads[existingIndex].name = nil
        threads = sortThreads(threads)
        requestImmediateSync(threadId: threadId)
    }
}
