import Foundation

@main struct Tests {
    static func main() {
        let start = Date(timeIntervalSince1970: 1_000_000)
        func snapshot(_ seconds: TimeInterval, running: [Date] = [], completed: [Date] = [], failed: [Date] = []) -> LiveActivityExpiration {
            LiveActivityExpiration(runningStartedAt: running, completedAt: completed, failedAt: failed,
                                   now: start.addingTimeInterval(seconds))
        }

        let empty = snapshot(0)
        precondition(empty.staleDate == nil && empty.nextRefreshDate == nil)
        let completed = snapshot(0, completed: [start])
        precondition(completed.staleDate == start.addingTimeInterval(300))
        precondition(completed.nextRefreshDate == completed.staleDate)
        let failed = snapshot(0, failed: [start])
        precondition(failed.nextRefreshDate == start.addingTimeInterval(900))
        let mixed = snapshot(0, running: [start], completed: [start], failed: [start])
        precondition(mixed.nextRefreshDate == completed.nextRefreshDate)
        let afterCompletion = snapshot(300, running: [start], completed: [start], failed: [start])
        precondition(afterCompletion.nextRefreshDate == failed.nextRefreshDate)
        precondition(snapshot(900, completed: [start], failed: [start]).nextRefreshDate == nil)

        let running = snapshot(0, running: [start])
        precondition(running.staleDate == start.addingTimeInterval(1800))
        precondition(running.nextRefreshDate == start.addingTimeInterval(1740))
        let nearCap = snapshot(14399, running: [start])
        precondition(nearCap.staleDate == start.addingTimeInterval(14400))
        precondition(nearCap.nextRefreshDate == nearCap.staleDate)
        let capped = snapshot(14400, running: [start])
        precondition(capped.staleDate == nil && capped.nextRefreshDate == nil)
        // Refreshing must not extend old outcomes; a newly started run has its own deadline.
        let resumed = snapshot(15000, running: [start, start.addingTimeInterval(15000)], completed: [start])
        precondition(resumed.staleDate == start.addingTimeInterval(16800))
        print("live activity expiration checks passed")
    }
}
