import Foundation

// Bounds badge retention and gives ActivityKit a deadline even while the app
// is suspended and cannot perform its next local refresh.
struct LiveActivityExpiration {
    static let completedLifetime: TimeInterval = 5 * 60
    static let failedLifetime: TimeInterval = 15 * 60
    static let runningLifetime: TimeInterval = 4 * 60 * 60
    private static let staleInterval: TimeInterval = 30 * 60
    private static let refreshLeadTime: TimeInterval = 60

    let staleDate: Date?
    let nextRefreshDate: Date?

    init(runningStartedAt: [Date], completedAt: [Date], failedAt: [Date], now: Date) {
        let runningDeadlines = runningStartedAt
            .map { $0.addingTimeInterval(Self.runningLifetime) }
            .filter { $0 > now }
        let deadlines = runningDeadlines
            + completedAt.map { $0.addingTimeInterval(Self.completedLifetime) }.filter { $0 > now }
            + failedAt.map { $0.addingTimeInterval(Self.failedLifetime) }.filter { $0 > now }
        let nextExpiration = deadlines.min()
        let quietDeadline = runningDeadlines.isEmpty ? nil : now.addingTimeInterval(Self.staleInterval)
        staleDate = [nextExpiration, quietDeadline].compactMap { $0 }.min()
        nextRefreshDate = [nextExpiration, quietDeadline?.addingTimeInterval(-Self.refreshLeadTime)]
            .compactMap { $0 }.min()
    }
}
