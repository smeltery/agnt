import Foundation

nonisolated enum TurnOutcomeAdmission {
    static func matchesLatestRun(completedTurnID: String?, activeTurnID: String?, lastStartedTurnID: String?) -> Bool {
        guard let completedTurnID else { return true }
        if let activeTurnID { return completedTurnID == activeTurnID }
        return lastStartedTurnID.map { $0 == completedTurnID } ?? true
    }
}
