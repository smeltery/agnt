import Foundation
struct CodexMessage: Sendable {
    var turnId: String?
    var orderIndex: Int
}
@main struct Tests {
    static func main() {
        let existing = [CodexMessage(turnId: "old-phone", orderIndex: 1), CodexMessage(turnId: "turn_boundary", orderIndex: 10)]
        let page = [CodexMessage(turnId: "middle", orderIndex: 0)]
        let result = HistoryPagePlacement.position(page: page, existing: existing, cursor: .string("agnt-opencode-turn:desc:turn_boundary"))!
        precondition(result.existing[0].orderIndex == 1)
        precondition(result.page[0].orderIndex == 10)
        precondition(result.existing[1].orderIndex == 11)
        precondition(HistoryPagePlacement.position(page: page, existing: existing, cursor: .string("other")) == nil)
        precondition(HistoryPagePlacement.position(page: page, existing: existing, cursor: .string("agnt-opencode-turn:desc:missing")) == nil)
        print("history placement checks passed")
    }
}
