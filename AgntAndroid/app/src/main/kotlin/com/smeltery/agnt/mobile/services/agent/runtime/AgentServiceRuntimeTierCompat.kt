package com.smeltery.agnt.mobile.services.agent.runtime

import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.core.model.CodexBridgeUpdatePrompt
import com.smeltery.agnt.mobile.services.agent.AgentService

/** Matches iOS `AgentService+RuntimeCompatibility.serviceTierBridgeUpdatePrompt.command`. */
internal const val SERVICE_TIER_BRIDGE_UPDATE_COMMAND = "bun install -g @smeltery/agnt"

/**
 * After the bridge rejects `serviceTier`, omit it for the rest of the session and optionally surface
 * [CodexBridgeUpdatePrompt] once (parity iOS `markServiceTierUnsupportedForCurrentBridge`).
 */
internal fun AgentService.markServiceTierUnsupportedForCurrentBridge() {
    supportsServiceTier = false
    if (_selectedServiceTier.value == null || hasPresentedServiceTierBridgeUpdatePrompt) return
    hasPresentedServiceTierBridgeUpdatePrompt = true
    _bridgeUpdatePrompt.value =
        CodexBridgeUpdatePrompt(
            title = appContext.getString(R.string.bridge_update_service_tier_title),
            message = appContext.getString(R.string.bridge_update_service_tier_message),
            command = SERVICE_TIER_BRIDGE_UPDATE_COMMAND,
        )
}
