import Foundation
@main struct Tests {
    static func main() {
        precondition(!TurnOutcomeAdmission.matchesLatestRun(completedTurnID: "old", activeTurnID: "new", lastStartedTurnID: "new"))
        precondition(!TurnOutcomeAdmission.matchesLatestRun(completedTurnID: "old", activeTurnID: nil, lastStartedTurnID: "new"))
        precondition(TurnOutcomeAdmission.matchesLatestRun(completedTurnID: "new", activeTurnID: "new", lastStartedTurnID: "new"))
        precondition(TurnOutcomeAdmission.matchesLatestRun(completedTurnID: nil, activeTurnID: "new", lastStartedTurnID: "new"))
        precondition(TurnOutcomeAdmission.matchesLatestRun(completedTurnID: "parallel", activeTurnID: "parallel", lastStartedTurnID: "newer-finished"))
        print("turn outcome admission checks passed")
    }
}
