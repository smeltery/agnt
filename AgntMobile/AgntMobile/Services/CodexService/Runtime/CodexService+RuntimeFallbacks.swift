// FILE: CodexService+RuntimeFallbacks.swift
// Purpose: Runtime request compatibility fallbacks for sandbox and approval policy payloads.
// Layer: Service
// Exports: CodexService runtime request fallback helpers
// Depends on: CodexAccessMode, RPCMessage, JSONValue

import Foundation

extension CodexService {
    // Sends one request while trying approvalPolicy enum variants for cross-version compatibility.
    func sendRequestWithApprovalPolicyFallback(
        method: String,
        baseParams: RPCObject,
        context: String
    ) async throws -> RPCMessage {
        let policies = selectedAccessMode.approvalPolicyCandidates
        let reviewers = selectedAccessMode.approvalsReviewerCandidates
        var lastError: Error?

        for (policyIndex, policy) in policies.enumerated() {
            for (reviewerIndex, reviewer) in reviewers.enumerated() {
                var params = baseParams
                params["approvalPolicy"] = .string(policy)
                if let reviewer {
                    params["approvalsReviewer"] = .string(reviewer)
                }

                do {
                    return try await sendRequest(method: method, params: .object(params))
                } catch {
                    lastError = error
                    let hasMoreReviewers = reviewerIndex < (reviewers.count - 1)
                    if hasMoreReviewers, shouldRetryWithApprovalsReviewerFallback(error) {
                        debugRuntimeLog("\(method) \(context) fallback approvalsReviewer=\(reviewer ?? "nil")")
                        continue
                    }
                    let hasMorePolicies = policyIndex < (policies.count - 1)
                    if hasMorePolicies, shouldRetryWithApprovalPolicyFallback(error) {
                        debugRuntimeLog("\(method) \(context) fallback approvalPolicy=\(policy)")
                        break
                    }
                    throw error
                }
            }
        }

        throw lastError ?? CodexServiceError.invalidResponse("\(method) failed with unknown approvalPolicy error")
    }

    func runtimeSandboxPolicyObject(for accessMode: CodexAccessMode) -> JSONValue {
        switch accessMode {
        case .onRequest, .autoReview:
            return .object([
                "type": .string("workspaceWrite"),
                "networkAccess": .bool(true),
            ])
        case .fullAccess:
            return .object([
                "type": .string("dangerFullAccess"),
            ])
        }
    }

    func shouldFallbackFromSandboxPolicy(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        if rpcError.code != -32602 && rpcError.code != -32600 {
            return false
        }

        let loweredMessage = rpcError.message.lowercased()
        if loweredMessage.contains("thread not found") || loweredMessage.contains("unknown thread") {
            return false
        }

        return loweredMessage.contains("invalid params")
            || loweredMessage.contains("invalid param")
            || loweredMessage.contains("unknown field")
            || loweredMessage.contains("unexpected field")
            || loweredMessage.contains("unrecognized field")
            || loweredMessage.contains("failed to parse")
            || loweredMessage.contains("unsupported")
    }

    func sendRequestWithSandboxFallback(method: String, baseParams: RPCObject) async throws -> RPCMessage {
        var firstAttemptParams = baseParams
        firstAttemptParams["sandboxPolicy"] = runtimeSandboxPolicyObject(for: selectedAccessMode)

        do {
            debugRuntimeLog("\(method) using sandboxPolicy")
            return try await sendRequestWithApprovalPolicyFallback(
                method: method,
                baseParams: firstAttemptParams,
                context: "sandboxPolicy"
            )
        } catch {
            guard shouldFallbackFromSandboxPolicy(error) else {
                throw error
            }
        }

        var secondAttemptParams = baseParams
        secondAttemptParams["sandbox"] = .string(selectedAccessMode.sandboxLegacyValue)

        do {
            debugRuntimeLog("\(method) fallback using sandbox")
            return try await sendRequestWithApprovalPolicyFallback(
                method: method,
                baseParams: secondAttemptParams,
                context: "sandbox"
            )
        } catch {
            guard shouldFallbackFromSandboxPolicy(error) else {
                throw error
            }
        }

        let finalAttemptParams = baseParams
        debugRuntimeLog("\(method) fallback using minimal payload")
        return try await sendRequestWithApprovalPolicyFallback(
            method: method,
            baseParams: finalAttemptParams,
            context: "minimal"
        )
    }

    func shouldRetryWithApprovalPolicyFallback(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        if rpcError.code != -32600 && rpcError.code != -32602 {
            return false
        }

        let message = rpcError.message.lowercased()
        return message.contains("approval")
            || message.contains("unknown variant")
            || message.contains("expected one of")
            || message.contains("onrequest")
            || message.contains("on-request")
    }

    func shouldRetryWithApprovalsReviewerFallback(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        if rpcError.code != -32600 && rpcError.code != -32602 {
            return false
        }

        let message = rpcError.message.lowercased()
        return message.contains("approvalsreviewer")
            || message.contains("approvals_reviewer")
            || message.contains("auto_review")
            || message.contains("guardian_subagent")
    }
}
