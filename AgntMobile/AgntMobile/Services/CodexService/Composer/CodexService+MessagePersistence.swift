// FILE: CodexService+MessagePersistence.swift
// Purpose: Persists message timelines and per-turn terminal state.
// Layer: Service
// Exports: CodexService message persistence helpers
// Depends on: CodexMessagePersistence

import Foundation

extension CodexService {
    func persistMessages() {
        messagePersistenceDebounceTask?.cancel()
        messagePersistenceDebounceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled, let self else { return }

            let snapshot = self.messagesByThread
            let macDeviceId = self.currentMacScopedPersistenceDeviceId
            self.messagePersistenceDebounceTask = nil

            Task.detached { [messagePersistence] in
                messagePersistence.save(snapshot, macDeviceId: macDeviceId)
            }
        }
    }

    // Persists per-turn terminal state so completed-turn grouping survives app relaunch.
    func persistTurnTerminalStates() {
        guard !suspendAutomaticMacScopedPersistence, !isApplyingMacScopedState else {
            return
        }

        guard !terminalStateByTurnID.isEmpty else {
            defaults.removeObject(forKey: macScopedDefaultsKey(Self.turnTerminalStatesDefaultsKey))
            return
        }

        guard let data = try? encoder.encode(terminalStateByTurnID) else {
            defaults.removeObject(forKey: macScopedDefaultsKey(Self.turnTerminalStatesDefaultsKey))
            return
        }

        defaults.set(data, forKey: macScopedDefaultsKey(Self.turnTerminalStatesDefaultsKey))
    }
}
