// FILE: CodexService+Approvals.swift
// Purpose: Manages approval request queues and approval response envelopes.
// Layer: Service Extension
// Exports: CodexService approval APIs
// Depends on: Foundation, JSONValue, CodexApprovalRequest

import Foundation

extension CodexService {
    // Encodes manual approval replies using the app-server decision object shape.
    func approvalDecisionResult(_ decision: String) -> JSONValue {
        .object(["decision": .string(decision)])
    }

    // New permission prompts use a grant payload, unlike command/file approval decisions.
    func permissionApprovalResult(for request: CodexApprovalRequest, grantsRequestedPermissions: Bool) -> JSONValue {
        let requestedPermissions = request.params?.objectValue?["permissions"] ?? .object([:])
        return .object([
            "permissions": grantsRequestedPermissions ? requestedPermissions : .object([:]),
            "scope": .string("turn"),
        ])
    }

    func approvalResponseResult(
        for request: CodexApprovalRequest,
        decision: String,
        forSession: Bool = false
    ) -> JSONValue {
        let normalizedMethod = request.method.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalizedMethod == "item/permissions/requestApproval" {
            return permissionApprovalResult(for: request, grantsRequestedPermissions: decision == "accept")
        }

        let isCommandApproval = normalizedMethod == "item/commandExecution/requestApproval"
            || normalizedMethod == "item/command_execution/request_approval"
        let resolvedDecision = (decision == "accept" && forSession && (isCommandApproval || runtimeSettingsProviderId == "opencode")) ? "acceptForSession" : decision
        return approvalDecisionResult(resolvedDecision)
    }

    // Returns the next pending approval for a specific thread, falling back to thread-less requests.
    func pendingApproval(for threadId: String? = nil) -> CodexApprovalRequest? {
        guard let normalizedThreadID = normalizedApprovalThreadIdentifier(threadId) else {
            return pendingApprovals.first
        }

        return pendingApprovals.first(where: { $0.threadId == normalizedThreadID })
            ?? pendingApprovals.first(where: { $0.threadId == nil })
    }

    // Preserves arrival order while replacing retried copies of the same request id.
    func enqueuePendingApproval(_ request: CodexApprovalRequest) {
        if let existingIndex = pendingApprovals.firstIndex(where: { $0.id == request.id }) {
            pendingApprovals[existingIndex] = request
            return
        }

        pendingApprovals.append(request)
    }

    // Removes the exact resolved approval request when the server confirms it is gone.
    @discardableResult
    func removePendingApproval(requestID: JSONValue) -> CodexApprovalRequest? {
        let requestKey = idKey(from: requestID)
        return removePendingApproval(id: requestKey)
    }

    // Clears all volatile approval prompts on disconnect or server switch.
    func clearPendingApprovals() {
        pendingApprovals.removeAll()
    }

    // Accepts the latest pending approval request.
    func approvePendingRequest(_ request: CodexApprovalRequest, forSession: Bool = false) async throws {
        let requestKey = request.id
        guard pendingApprovals.contains(where: { $0.id == requestKey }) else {
            throw CodexServiceError.noPendingApproval
        }

        try await sendResponse(
            id: request.requestID,
            result: approvalResponseResult(for: request, decision: "accept", forSession: forSession)
        )
        removePendingApproval(requestID: request.requestID)
    }

    // Accepts the next pending approval request, optionally scoped to a thread.
    func approvePendingRequest(forThread threadId: String? = nil, forSession: Bool = false) async throws {
        guard let request = pendingApproval(for: threadId) else {
            throw CodexServiceError.noPendingApproval
        }

        try await approvePendingRequest(request, forSession: forSession)
    }

    // Declines the latest pending approval request.
    func declinePendingRequest(_ request: CodexApprovalRequest) async throws {
        let requestKey = request.id
        guard pendingApprovals.contains(where: { $0.id == requestKey }) else {
            throw CodexServiceError.noPendingApproval
        }

        try await sendResponse(
            id: request.requestID,
            result: approvalResponseResult(for: request, decision: "decline")
        )
        removePendingApproval(requestID: request.requestID)
    }

    // Declines the next pending approval request, optionally scoped to a thread.
    func declinePendingRequest(forThread threadId: String? = nil) async throws {
        guard let request = pendingApproval(for: threadId) else {
            throw CodexServiceError.noPendingApproval
        }

        try await declinePendingRequest(request)
    }
}

private extension CodexService {
    @discardableResult
    func removePendingApproval(id requestID: String) -> CodexApprovalRequest? {
        guard let exactIndex = pendingApprovals.firstIndex(where: { $0.id == requestID }) else {
            return nil
        }

        return pendingApprovals.remove(at: exactIndex)
    }

    func normalizedApprovalThreadIdentifier(_ rawValue: String?) -> String? {
        guard let rawValue else {
            return nil
        }

        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
