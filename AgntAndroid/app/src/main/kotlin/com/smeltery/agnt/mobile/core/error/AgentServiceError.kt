package com.smeltery.agnt.mobile.core.error

import com.smeltery.agnt.mobile.core.model.RPCError

/**
 * Taxonomy of failures from the bridge client layer (transport, RPC, validation).
 * Mirrors [AgentServiceError.swift](CodexMobile/CodexMobile/Services/AgentServiceError.swift).
 */
sealed class AgentServiceError(
    message: String,
) : Exception(message) {
    class InvalidServerURL(
        val value: String,
    ) : AgentServiceError("Invalid server URL: $value")

    class InvalidInput(
        reason: String,
    ) : AgentServiceError(reason)

    class InvalidResponse(
        reason: String,
    ) : AgentServiceError(reason)

    data object EncodingFailed : AgentServiceError("Unable to encode JSON-RPC payload")

    data object Disconnected : AgentServiceError("WebSocket not connected")

    data object NoPendingApproval : AgentServiceError("No pending approval request")

    class RpcFailure(
        val rpcError: RPCError,
    ) : AgentServiceError("RPC error ${rpcError.code}: ${rpcError.message}")

    /** After [com.smeltery.agnt.mobile.services.handleMissingThread]; clearer than raw -32600 in UI. */
    data object ThreadRemovedOnServer : AgentServiceError(
        "This conversation is no longer on the bridge. Choose another thread or start a new chat.",
    )
}
