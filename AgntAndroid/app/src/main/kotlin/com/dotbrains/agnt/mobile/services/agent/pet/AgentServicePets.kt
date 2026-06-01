package com.dotbrains.agnt.mobile.services.agent.pet

import com.dotbrains.agnt.mobile.core.error.AgentServiceError
import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.core.model.PetCompanion
import com.dotbrains.agnt.mobile.data.CodexRepository

/**
 * Loads Codex-compatible local pet packages through the paired bridge
 * (parity [AgentService+Pets.swift](CodexMobile/CodexMobile/Features/Pet/CodexService+Pets.swift)).
 *
 * `pet/list` returns metadata only by default to keep relay payloads small; the
 * selected pet's spritesheet is hydrated separately via [readPet]. The bridge
 * handler (`agnt-bridge/src/handlers/pet-handler.js`) is provider-agnostic — it
 * reads `~/.codex/pets` / `~/.codex/avatars` regardless of the active CLI. These
 * target [CodexRepository.sendRequest] so the pet store depends only on the
 * interface.
 */
suspend fun CodexRepository.listPets(includeData: Boolean = false): List<PetCompanion> {
    val response =
        sendRequest(
            method = "pet/list",
            params =
                JSONValue.Obj(
                    mapOf(
                        "includeData" to JSONValue.Bool(includeData),
                        "metadataOnly" to JSONValue.Bool(!includeData),
                    ),
                ),
        )
    response.error?.let { throw AgentServiceError.RpcFailure(it) }

    val result =
        response.result?.objectValue
            ?: throw AgentServiceError.InvalidResponse("The bridge returned an invalid pet list.")
    val rawPets = result["avatars"]?.arrayValue ?: result["pets"]?.arrayValue ?: emptyList()
    return rawPets.mapNotNull { petCompanion(it, requiresSpritesheetData = includeData) }
}

suspend fun CodexRepository.readPet(id: String): PetCompanion =
    try {
        readPetDirect(id)
    } catch (error: Throwable) {
        val fallback =
            if (isUnsupportedPetReadError(error)) {
                listPets(includeData = true).firstOrNull { it.id == id }
            } else {
                null
            }
        fallback ?: throw error
    }

private suspend fun CodexRepository.readPetDirect(id: String): PetCompanion {
    val response =
        sendRequest(method = "pet/read", params = JSONValue.Obj(mapOf("id" to JSONValue.Str(id))))
    response.error?.let { throw AgentServiceError.RpcFailure(it) }
    val result =
        response.result
            ?: throw AgentServiceError.InvalidResponse("The bridge returned an invalid pet.")
    return petCompanion(result, requiresSpritesheetData = true)
        ?: throw AgentServiceError.InvalidResponse("The bridge returned an invalid pet.")
}

private fun isUnsupportedPetReadError(error: Throwable): Boolean {
    val rpc = (error as? AgentServiceError.RpcFailure)?.rpcError ?: return false
    val message = rpc.message.lowercase()
    return message.contains("unknown variant") ||
        message.contains("unknown method") ||
        message.contains("pet/read")
}

internal fun petCompanion(
    value: JSONValue,
    requiresSpritesheetData: Boolean,
): PetCompanion? {
    val obj = value.objectValue ?: return null
    val id = obj["id"]?.stringValue?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val displayName = obj["displayName"]?.stringValue?.trim()?.takeIf { it.isNotEmpty() } ?: return null

    val dataUrl = obj["spritesheetDataUrl"]?.stringValue?.trim()
    if (requiresSpritesheetData && dataUrl.isNullOrEmpty()) return null

    return PetCompanion(
        id = id,
        folderName = obj["folderName"]?.stringValue ?: id,
        displayName = displayName,
        description = obj["description"]?.stringValue,
        spritesheetDataUrl = dataUrl,
        spritesheetMimeType = obj["spritesheetMimeType"]?.stringValue,
        spritesheetByteLength = obj["spritesheetByteLength"]?.intValue,
    )
}
