// FILE: CodexAutoApprovalReview.swift
// Purpose: Models automatic approval-review lifecycle rows emitted by the local runtime.
// Layer: Model
// Exports: CodexAutoApprovalReview, CodexAutoApprovalReviewStatus
// Depends on: Foundation, JSONValue

import Foundation

enum CodexAutoApprovalReviewStatus: Codable, Hashable, Sendable {
    case inProgress
    case approved
    case denied
    case timedOut
    case aborted
    case unknown(String)

    init(rawValue: String) {
        switch rawValue {
        case "inProgress": self = .inProgress
        case "approved": self = .approved
        case "denied": self = .denied
        case "timedOut": self = .timedOut
        case "aborted": self = .aborted
        default: self = .unknown(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .inProgress: return "inProgress"
        case .approved: return "approved"
        case .denied: return "denied"
        case .timedOut: return "timedOut"
        case .aborted: return "aborted"
        case .unknown(let value): return value
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self.init(rawValue: try container.decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    var isTerminal: Bool {
        switch self {
        case .inProgress:
            return false
        default:
            return true
        }
    }
}

struct CodexAutoApprovalReview: Codable, Hashable, Sendable {
    let reviewId: String
    let targetItemId: String?
    let turnId: String
    let startedAtMs: Int
    var completedAtMs: Int?
    var status: CodexAutoApprovalReviewStatus
    let riskLevel: String?
    let userAuthorization: String?
    let rationale: String?
    let decisionSource: String?
    var action: JSONValue
    var retryApproved: Bool
    var retryUnavailableReason: String?

    var actionSummary: String {
        guard let object = action.objectValue,
              let type = object["type"]?.stringValue else {
            return "Requested action"
        }

        switch type {
        case "command":
            return object["command"]?.stringValue ?? "Run command"
        case "execve":
            let program = object["program"]?.stringValue ?? "Run command"
            let arguments = object["argv"]?.arrayValue?.compactMap(\.stringValue) ?? []
            return arguments.isEmpty
                ? shellQuoted(program)
                : arguments.map(shellQuoted).joined(separator: " ")
        case "applyPatch":
            let files = object["files"]?.arrayValue?.compactMap(\.stringValue) ?? []
            if files.isEmpty { return "Apply file changes" }
            return files.count == 1
                ? "Edit \(files[0])"
                : "Edit \(files.count) files: \(files.joined(separator: ", "))"
        case "networkAccess":
            let host = object["host"]?.stringValue ?? object["target"]?.stringValue
            let port = object["port"]?.intValue.map(String.init)
            let target = [host, port].compactMap { $0 }.joined(separator: ":")
            return target.isEmpty ? "Access the network" : "Access \(target)"
        case "mcpToolCall":
            let server = object["server"]?.stringValue
            let tool = object["toolTitle"]?.stringValue ?? object["toolName"]?.stringValue
            let summary = [server, tool].compactMap { $0 }.joined(separator: ".")
            return summary.isEmpty ? "Call MCP tool" : summary
        case "requestPermissions":
            return object["reason"]?.stringValue ?? "Request additional permissions"
        default:
            return "Requested action"
        }
    }

    private func shellQuoted(_ value: String) -> String {
        let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_./-"))
        if value.unicodeScalars.allSatisfy(safe.contains) {
            return value
        }
        return "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }
}
