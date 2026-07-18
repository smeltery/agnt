// FILE: GoalCommandParser.swift
// Purpose: Parses inline `/goal` composer commands.
// Layer: View Support
// Exports: GoalCommandParser
// Depends on: Foundation

import Foundation

enum GoalCommandParser {
    static func parse(_ input: String) -> (isGoalCommand: Bool, objective: String?) {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/goal") else { return (false, nil) }
        let remainderStart = trimmed.index(trimmed.startIndex, offsetBy: "/goal".count)
        let remainder = trimmed[remainderStart...]
        guard remainder.isEmpty || remainder.first?.isWhitespace == true else { return (false, nil) }
        let objective = remainder.trimmingCharacters(in: .whitespacesAndNewlines)
        return (true, objective.isEmpty ? nil : objective)
    }
}
