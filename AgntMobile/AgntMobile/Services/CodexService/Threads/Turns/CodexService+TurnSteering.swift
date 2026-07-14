// FILE: CodexService+TurnSteering.swift
// Purpose: turn/steer, turn retry compatibility, and compaction helpers.
// Layer: Service

import Foundation

extension CodexService {
    // Steers an active turn using the same mixed input-item encoding as turn/start.
    func steerTurn(
        userInput: String,
        threadId: String,
        expectedTurnId: String?,
        attachments: [CodexImageAttachment] = [],
        skillMentions: [CodexTurnSkillMention] = [],
        mentionMentions: [CodexTurnMention] = [],
        fileMentions: [String] = [],
        shouldAppendUserMessage: Bool = true,
        preAppendedUserMessageID: String? = nil,
        collaborationMode: CodexCollaborationModeKind? = nil
    ) async throws {
        let normalizedThreadID = normalizedInterruptIdentifier(threadId) ?? threadId
        let effectiveRequestedCollaborationMode = collaborationModeForOutgoingTurn(
            threadId: normalizedThreadID,
            requestedMode: collaborationMode
        )
        preparePlanSessionForSteer(
            threadId: normalizedThreadID,
            collaborationMode: effectiveRequestedCollaborationMode
        )
        let normalizedPreAppendedUserMessageID = normalizedInterruptIdentifier(preAppendedUserMessageID)
        let pendingMessageId: String
        if let normalizedPreAppendedUserMessageID {
            pendingMessageId = normalizedPreAppendedUserMessageID
        } else if shouldAppendUserMessage {
            pendingMessageId = appendUserMessage(
                threadId: normalizedThreadID,
                text: displayTextForOutgoingTurn(
                    userInput: userInput,
                    skillMentions: skillMentions,
                    mentionMentions: mentionMentions
                ),
                attachments: attachments,
                fileMentions: fileMentions,
                skillMentions: skillMentions.compactMap {
                    let rawName = $0.name ?? $0.id
                    let normalized = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
                    return normalized.isEmpty ? nil : normalized
                },
                pluginMentions: mentionMentions.compactMap {
                    let normalized = $0.name.trimmingCharacters(in: .whitespacesAndNewlines)
                    return normalized.isEmpty ? nil : normalized
                }
            )
        } else {
            pendingMessageId = ""
        }
        var resolvedExpectedTurnID = normalizedInterruptIdentifier(expectedTurnId)
        if resolvedExpectedTurnID == nil {
            do {
                resolvedExpectedTurnID = try await resolveInFlightTurnID(threadId: normalizedThreadID)
            } catch {
                handleSteerFailure(error, pendingMessageId: pendingMessageId, threadId: normalizedThreadID)
                throw error
            }
        }

        guard let initialTurnID = resolvedExpectedTurnID else {
            let error = CodexServiceError.invalidInput("No active turn available to steer")
            handleSteerFailure(error, pendingMessageId: pendingMessageId, threadId: normalizedThreadID)
            throw error
        }

        var includeStructuredSkillItems = supportsStructuredSkillInput && !skillMentions.isEmpty
        var includeStructuredMentionItems = supportsStructuredMentionInput && !mentionMentions.isEmpty
        var imageURLKey = "url"
        var effectiveCollaborationMode = supportsTurnCollaborationMode ? effectiveRequestedCollaborationMode : nil
        var currentExpectedTurnID = initialTurnID
        var didRetryWithRefreshedTurnID = false

        if effectiveRequestedCollaborationMode != nil, effectiveCollaborationMode == nil {
            debugRuntimeLog(
                "turn/steer dropping collaborationMode requested=\(effectiveRequestedCollaborationMode?.rawValue ?? "") thread=\(normalizedThreadID) supportsTurnCollaborationMode=\(supportsTurnCollaborationMode)"
            )
        }

        while true {
            var params: RPCObject = [
                "threadId": .string(normalizedThreadID),
                "expectedTurnId": .string(currentExpectedTurnID),
                "input": .array(
                    makeTurnInputPayload(
                        userInput: userInput,
                        attachments: attachments,
                        imageURLKey: imageURLKey,
                        skillMentions: skillMentions,
                        mentionMentions: mentionMentions,
                        includeStructuredSkillItems: includeStructuredSkillItems,
                        includeStructuredMentionItems: includeStructuredMentionItems
                    )
                ),
            ]
            if let collaborationModePayload = try buildCollaborationModePayload(
                for: effectiveCollaborationMode,
                threadId: normalizedThreadID
            ) {
                params["collaborationMode"] = collaborationModePayload
            }

            do {
                let response = try await sendRequest(method: "turn/steer", params: .object(params))
                let resolvedTurnID = extractTurnID(from: response.result) ?? currentExpectedTurnID
                markMessageDeliveryState(
                    threadId: normalizedThreadID,
                    messageId: pendingMessageId,
                    state: .confirmed,
                    turnId: resolvedTurnID
                )
                activeTurnId = resolvedTurnID
                setActiveTurnID(resolvedTurnID, for: normalizedThreadID)
                threadIdByTurnID[resolvedTurnID] = normalizedThreadID
                markThreadAsRunning(normalizedThreadID)
                setProtectedRunningFallback(false, for: normalizedThreadID)
                return
            } catch {
                if includeStructuredSkillItems,
                   shouldRetryTurnStartWithoutSkillItems(error) {
                    supportsStructuredSkillInput = false
                    includeStructuredSkillItems = false
                    continue
                }

                if includeStructuredMentionItems,
                   shouldRetryTurnStartWithoutMentionItems(error) {
                    supportsStructuredMentionInput = false
                    includeStructuredMentionItems = false
                    continue
                }

                if imageURLKey == "url",
                   !attachments.isEmpty,
                   shouldRetryTurnStartWithImageURLField(error) {
                    imageURLKey = "image_url"
                    continue
                }

                if effectiveCollaborationMode != nil,
                   shouldRetryTurnStartWithoutCollaborationMode(error) {
                    // Keep steer compatible with runtimes that only support plain turns.
                    supportsTurnCollaborationMode = false
                    clearPlanSessionIfRuntimeDowngraded(
                        threadId: normalizedThreadID,
                        collaborationMode: effectiveCollaborationMode
                    )
                    effectiveCollaborationMode = nil
                    continue
                }

                if !didRetryWithRefreshedTurnID,
                   shouldRetrySteerWithRefreshedTurnID(error) {
                    do {
                        if let refreshedTurnID = try await resolveInFlightTurnID(threadId: normalizedThreadID),
                           refreshedTurnID != currentExpectedTurnID {
                            didRetryWithRefreshedTurnID = true
                            currentExpectedTurnID = refreshedTurnID
                            activeTurnId = refreshedTurnID
                            setActiveTurnID(refreshedTurnID, for: normalizedThreadID)
                            threadIdByTurnID[refreshedTurnID] = normalizedThreadID
                            continue
                        }
                    } catch {
                        handleSteerFailure(error, pendingMessageId: pendingMessageId, threadId: normalizedThreadID)
                        throw error
                    }
                }

                handleSteerFailure(error, pendingMessageId: pendingMessageId, threadId: normalizedThreadID)
                throw error
            }
        }
    }

    // Applies common failure bookkeeping for turn/start primary and fallback attempts.
    func handleTurnStartFailure(
        _ error: Error,
        pendingMessageId: String,
        threadId: String
    ) throws {
        markMessageDeliveryState(threadId: threadId, messageId: pendingMessageId, state: .failed)
        clearRunningState(for: threadId)
        if shouldTreatAsThreadNotFound(error) {
            throw error
        }

        if let footerMessage = userFacingTurnErrorMessageForFooter(from: error) {
            lastErrorMessage = footerMessage
        } else {
            lastErrorMessage = nil
        }
        if !shouldSuppressRuntimeErrorInChat(error),
           let errorMessage = userFacingTurnErrorMessageForFooter(from: error) {
            appendSystemMessage(threadId: threadId, text: "Send error: \(errorMessage)")
        }
        throw error
    }

    // Handles successful turn/start bookkeeping for both primary and fallback payload schemas.
    @discardableResult
    func handleSuccessfulTurnStartResponse(
        _ response: RPCMessage,
        pendingMessageId: String,
        threadId: String
    ) -> String? {
        let turnID = extractTurnID(from: response.result)
        let resolvedTurnID = turnID ?? activeTurnIdByThread[threadId]
        let deliveryState: CodexMessageDeliveryState = (resolvedTurnID == nil) ? .pending : .confirmed
        markMessageDeliveryState(
            threadId: threadId,
            messageId: pendingMessageId,
            state: deliveryState,
            turnId: resolvedTurnID
        )

        if let turnID = resolvedTurnID {
            activeTurnId = turnID
            setActiveTurnID(turnID, for: threadId)
            threadIdByTurnID[turnID] = threadId
            setProtectedRunningFallback(false, for: threadId)
            beginAssistantMessage(threadId: threadId, turnId: turnID)
        }

        if let index = threadIndex(for: threadId) {
            threads[index].updatedAt = Date()
            threads[index].syncState = .live
            threads = sortThreads(threads)
        }

        return resolvedTurnID
    }

    // Applies steer failure bookkeeping for optimistic user rows without adding an extra system error card.
    func handleSteerFailure(
        _ error: Error,
        pendingMessageId: String,
        threadId: String
    ) {
        markMessageDeliveryState(threadId: threadId, messageId: pendingMessageId, state: .failed)
        lastErrorMessage = userFacingTurnErrorMessageForFooter(from: error)
    }

    // Some server versions expect `image_url` instead of `url` for image items.
    func shouldRetryTurnStartWithImageURLField(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        let message = rpcError.message.lowercased()
        guard message.contains("image_url") else {
            return false
        }

        return message.contains("missing")
            || message.contains("unknown field")
            || message.contains("expected")
            || message.contains("invalid")
    }

    // Detects legacy servers that reject input items with `type: "skill"`.
    func shouldRetryTurnStartWithoutSkillItems(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        let message = rpcError.message.lowercased()
        guard message.contains("skill") || isGenericStructuredInputItemRejection(message) else {
            return false
        }

        return message.contains("unknown")
            || message.contains("unsupported")
            || message.contains("invalid")
            || message.contains("expected")
            || message.contains("unrecognized")
            || message.contains("type")
            || message.contains("field")
    }

    // Detects legacy runtimes that reject input items with `type: "mention"`.
    func shouldRetryTurnStartWithoutMentionItems(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        let message = rpcError.message.lowercased()
        guard message.contains("mention") || isGenericStructuredInputItemRejection(message) else {
            return false
        }

        return message.contains("unknown")
            || message.contains("unsupported")
            || message.contains("invalid")
            || message.contains("expected")
            || message.contains("unrecognized")
            || message.contains("type")
            || message.contains("field")
    }

    private func isGenericStructuredInputItemRejection(_ message: String) -> Bool {
        let mentionsInputShape = message.contains("input")
            && (message.contains("item") || message.contains("type") || message.contains("array") || message.contains("schema"))
        let rejectsShape = message.contains("unknown")
            || message.contains("unsupported")
            || message.contains("invalid")
            || message.contains("expected")
            || message.contains("unrecognized")
            || message.contains("field")
        return mentionsInputShape && rejectsShape
    }

    // Detects runtimes that reject plan-mode `collaborationMode` without `experimentalApi`.
    func shouldRetryTurnStartWithoutCollaborationMode(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        let message = rpcError.message.lowercased()
        guard message.contains("collaborationmode") || message.contains("collaboration_mode") else {
            return false
        }

        return message.contains("experimentalapi")
            || message.contains("unsupported")
            || message.contains("unknown")
            || message.contains("unexpected")
            || message.contains("unrecognized")
            || message.contains("invalid")
            || message.contains("field")
            || message.contains("mode")
    }

    // Starts the app-server's manual context compaction turn for the selected thread.
    func compactThread(_ threadId: String) async throws {
        activeThreadId = threadId
        markThreadAsRunning(threadId)
        setProtectedRunningFallback(true, for: threadId)

        do {
            _ = try await sendRequest(
                method: "thread/compact/start",
                params: .object(["threadId": .string(threadId)])
            )
            lastErrorMessage = nil
        } catch {
            clearRunningState(for: threadId)
            let errorMessage = userFacingTurnErrorMessage(from: error)
            lastErrorMessage = errorMessage
            appendSystemMessage(threadId: threadId, text: "Compact error: \(errorMessage)")
            throw error
        }
    }
}
