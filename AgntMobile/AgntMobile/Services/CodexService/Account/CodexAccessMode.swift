// FILE: CodexAccessMode.swift
// Purpose: Runtime permission mode for thread/turn operations.
// Layer: Model
// Exports: CodexAccessMode
// Depends on: Foundation

import Foundation

enum CodexAccessMode: String, Codable, CaseIterable, Hashable, Sendable {
    case onRequest = "on-request"
    case autoReview = "auto-review"
    case fullAccess = "full-access"

    var displayName: String {
        switch self {
        case .onRequest:
            return "Ask"
        case .autoReview:
            return "Review"
        case .fullAccess:
            return "Full"
        }
    }

    var menuTitle: String {
        switch self {
        case .onRequest:
            return "On-Request"
        case .autoReview:
            return "Approve for Me"
        case .fullAccess:
            return "Full Access"
        }
    }

    var pickerTitle: String {
        switch self {
        case .onRequest:
            return "Ask Each Time"
        case .autoReview:
            return "Approve for Me"
        case .fullAccess:
            return "Full Access"
        }
    }

    var pickerSubtitle: String {
        switch self {
        case .onRequest:
            return "Prompt before commands and file changes."
        case .autoReview:
            return "Let the local reviewer approve low-risk actions."
        case .fullAccess:
            return "Run without approval prompts."
        }
    }

    // Tries modern approval-policy enums first, then the bridge's kebab-case sandbox enum fallback.
    var approvalPolicyCandidates: [String] {
        switch self {
        case .onRequest, .autoReview:
            return ["on-request", "onRequest"]
        case .fullAccess:
            return ["never"]
        }
    }

    var approvalsReviewerCandidates: [String?] {
        switch self {
        case .onRequest, .fullAccess:
            return [nil]
        case .autoReview:
            return ["auto_review", "guardian_subagent"]
        }
    }

    var sandboxLegacyValue: String {
        switch self {
        case .onRequest, .autoReview:
            return "workspace-write"
        case .fullAccess:
            return "danger-full-access"
        }
    }
}
