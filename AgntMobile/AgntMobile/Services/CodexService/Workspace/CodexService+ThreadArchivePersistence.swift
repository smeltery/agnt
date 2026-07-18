// FILE: CodexService+ThreadArchivePersistence.swift
// Purpose: Persisted local archive and delete thread sets.
// Layer: Service

import Foundation

extension CodexService {
    /// Best-effort server-side archive/unarchive. Failures are logged but never
    /// surface to the user or trigger reconnection side-effects.
    func sendThreadArchiveRPC(threadId: String, unarchive: Bool) {
        guard isConnected, webSocketConnection != nil || webSocketTask != nil else { return }
        let method = unarchive ? "thread/unarchive" : "thread/archive"
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                _ = try await self.sendRequest(method: method, params: .object(["threadId": .string(threadId)]))
                self.debugSyncLog("\(method) RPC success: \(threadId)")
            } catch {
                self.debugSyncLog("\(method) RPC failed (non-fatal): \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Persisted archive/delete sets

    var locallyArchivedThreadIDs: Set<String> {
        Set(defaults.stringArray(forKey: macScopedDefaultsKey(Self.locallyArchivedThreadIDsKey)) ?? [])
    }

    var locallyDeletedThreadIDs: Set<String> {
        Set(defaults.stringArray(forKey: macScopedDefaultsKey(Self.locallyDeletedThreadIDsKey)) ?? [])
    }

    func addLocallyArchivedThreadID(_ threadId: String) {
        var ids = locallyArchivedThreadIDs
        ids.insert(threadId)
        defaults.set(Array(ids), forKey: macScopedDefaultsKey(Self.locallyArchivedThreadIDsKey))
    }

    func removeLocallyArchivedThreadID(_ threadId: String) {
        var ids = locallyArchivedThreadIDs
        ids.remove(threadId)
        defaults.set(Array(ids), forKey: macScopedDefaultsKey(Self.locallyArchivedThreadIDsKey))
    }

    func addLocallyDeletedThreadID(_ threadId: String) {
        var ids = locallyDeletedThreadIDs
        ids.insert(threadId)
        defaults.set(Array(ids), forKey: macScopedDefaultsKey(Self.locallyDeletedThreadIDsKey))
    }
}
