package com.dotbrains.agnt.mobile.services.agent.runtime

import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.error.AgentServiceError
import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.core.model.RPCMessage
import com.dotbrains.agnt.mobile.core.model.UsageStatusRefreshPolicy
import com.dotbrains.agnt.mobile.core.transport.ConnectionState
import com.dotbrains.agnt.mobile.services.agent.AgentService
import com.dotbrains.agnt.mobile.services.agent.threads.refreshContextWindowUsageInternal
import com.dotbrains.agnt.mobile.services.agent.threads.sendRequestImpl
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Account rate limits (`account/rateLimits/read`, `account/rateLimits/updated`).
 * Parity with [AgentService+Status.swift](../../../../../../../../CodexMobile/CodexMobile/Services/AgentService+Status.swift).
 */
internal fun AgentService.applyRateLimitsPayload(
    payloadObject: Map<String, JSONValue>,
    mergeWithExisting: Boolean,
) {
    val decoded = RateLimitPayloadCodec.decodeRateLimitBuckets(payloadObject)
    val resolved =
        if (mergeWithExisting) {
            RateLimitPayloadCodec.mergeRateLimitBuckets(
                _rateLimitBuckets.value,
                decoded,
            )
        } else {
            decoded
        }
    _rateLimitBuckets.value =
        resolved.sortedWith { lhs, rhs ->
            if (lhs.sortDurationMins == rhs.sortDurationMins) {
                lhs.displayLabel.compareTo(rhs.displayLabel, ignoreCase = true)
            } else {
                lhs.sortDurationMins.compareTo(rhs.sortDurationMins)
            }
        }
}

internal fun AgentService.handleRateLimitsUpdatedParams(params: Map<String, JSONValue>?) {
    if (params == null) return
    applyRateLimitsPayload(params, mergeWithExisting = true)
    _hasResolvedRateLimitsSnapshot.value = true
    _rateLimitsErrorMessage.value = null
}

internal suspend fun AgentService.refreshRateLimitsForRepository() =
    withContext(Dispatchers.IO) {
        refreshRateLimitsInternal()
    }

internal suspend fun AgentService.refreshUsageStatusForRepository(threadId: String?) =
    withContext(Dispatchers.IO) {
        val tid = threadId?.trim().orEmpty()
        if (tid.isNotEmpty()) {
            refreshContextWindowUsageInternal(tid)
        }
        refreshRateLimitsInternal()
    }

internal fun AgentService.shouldAutoRefreshUsageStatusForRepository(threadId: String?): Boolean =
    UsageStatusRefreshPolicy.shouldAutoRefresh(
        sessionReady = sessionReady,
        connected = _connectionState.value is ConnectionState.Connected,
        threadId = threadId,
        contextWindowUsageByThread = _contextWindowUsageByThread.value,
        hasResolvedRateLimitsSnapshot = _hasResolvedRateLimitsSnapshot.value,
    )

internal suspend fun AgentService.refreshRateLimitsInternal() {
    if (!sessionReady) {
        return
    }
    _isLoadingRateLimits.value = true
    try {
        val response = fetchRateLimitsWithCompatRetry()
        val resultObject = response.result?.objectValue
        if (resultObject == null) {
            throw AgentServiceError.InvalidResponse("account/rateLimits/read response missing payload")
        }
        applyRateLimitsPayload(resultObject, mergeWithExisting = false)
        _hasResolvedRateLimitsSnapshot.value = true
        _rateLimitsErrorMessage.value = null
    } catch (e: Exception) {
        _hasResolvedRateLimitsSnapshot.value = false
        _rateLimitBuckets.value = emptyList()
        val message = e.message?.trim().orEmpty()
        _rateLimitsErrorMessage.value =
            if (message.isEmpty()) {
                appContext.getString(R.string.usage_rate_limits_load_failed)
            } else {
                message
            }
    } finally {
        _isLoadingRateLimits.value = false
    }
}

private suspend fun AgentService.fetchRateLimitsWithCompatRetry(): RPCMessage =
    try {
        sendRequestImpl("account/rateLimits/read", JSONValue.Null)
    } catch (e: Exception) {
        if (!shouldRetryRateLimitsWithEmptyParams(e)) throw e
        sendRequestImpl("account/rateLimits/read", JSONValue.Obj(emptyMap()))
    }

private fun shouldRetryRateLimitsWithEmptyParams(e: Throwable): Boolean {
    val rpc = (e as? AgentServiceError.RpcFailure)?.rpcError ?: return false
    if (rpc.code != -32602 && rpc.code != -32600) return false
    val lowered = rpc.message.lowercase()
    return lowered.contains("invalid params") ||
        lowered.contains("invalid param") ||
        lowered.contains("failed to parse") ||
        lowered.contains("expected") ||
        lowered.contains("missing field `params`") ||
        lowered.contains("missing field params")
}
