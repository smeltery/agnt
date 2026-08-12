// FILE: CodexService+RuntimeConfig.swift
// Purpose: Runtime model/reasoning/access preferences, per-thread overrides, and model/list loading.
// Layer: Service
// Exports: CodexService runtime config APIs
// Depends on: CodexModelOption, CodexReasoningEffortOption, CodexAccessMode

import Foundation

private enum RuntimeSelectionDefaults {
    static let modelId = "gpt-5.5"
    static let reasoningEffort = "medium"

    static func reasoningEffort(for unresolvedModelId: String?) -> String? {
        guard let unresolvedModelId,
              unresolvedModelId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == modelId else {
            return nil
        }
        return reasoningEffort
    }
}

extension CodexService {
    // Resolves the effective per-chat override record after normalizing the thread id.
    func threadRuntimeOverride(for threadId: String?) -> CodexThreadRuntimeOverride? {
        guard let normalizedThreadID = normalizedInterruptIdentifier(threadId) else {
            return nil
        }
        return threadRuntimeOverridesByThreadID[normalizedThreadID]
    }

    // On-demand retry for runtime surfaces: the bootstrap `model/list` can fail
    // or still be in flight when the user opens a picker, and nothing else
    // re-requests it until the next reconnect. Cheap no-op once models exist.
    func refreshModelsIfNeeded() {
        guard availableModels.isEmpty, !isLoadingModels, isConnected else { return }
        Task { @MainActor [weak self] in
            try? await self?.listModels()
        }
    }

    func listModels() async throws {
        isLoadingModels = true
        defer { isLoadingModels = false }

        do {
            let response = try await sendRequest(
                method: "model/list",
                params: .object([
                    "cursor": .null,
                    "limit": .integer(50),
                    "includeHidden": .bool(false),
                ])
            )

            guard let resultObject = response.result?.objectValue else {
                throw CodexServiceError.invalidResponse("model/list response missing payload")
            }

            let items =
                resultObject["items"]?.arrayValue
                ?? resultObject["data"]?.arrayValue
                ?? resultObject["models"]?.arrayValue
                ?? []

            let decodedModels = items.compactMap { decodeModel(CodexModelOption.self, from: $0) }
            availableModels = decodedModels
            modelsErrorMessage = nil
            normalizeRuntimeSelectionsAfterModelsUpdate()

            debugRuntimeLog("model/list success count=\(decodedModels.count)")
        } catch {
            handleModelListFailure(error)
            throw error
        }
    }

    func setSelectedModelId(_ modelId: String?) {
        let normalized = modelId?.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized?.isEmpty == false {
            selectedModelId = normalized
        } else {
            selectedModelId = RuntimeSelectionDefaults.modelId
            selectedReasoningEffort = RuntimeSelectionDefaults.reasoningEffort
        }
        hasPersistedSelectedModelId = true
        normalizeRuntimeSelectionsAfterModelsUpdate()
    }

    func setSelectedGitWriterModelId(_ modelId: String?) {
        let normalized = modelId?.trimmingCharacters(in: .whitespacesAndNewlines)
        selectedGitWriterModelId = (normalized?.isEmpty == false) ? normalized : nil
        normalizeRuntimeSelectionsAfterModelsUpdate()
    }

    func setSelectedReasoningEffort(_ effort: String?) {
        let normalized = effort?.trimmingCharacters(in: .whitespacesAndNewlines)
        selectedReasoningEffort = (normalized?.isEmpty == false) ? normalized : nil
        normalizeRuntimeSelectionsAfterModelsUpdate()
    }

    func setThreadReasoningEffortOverride(_ effort: String, for threadId: String?) {
        guard let normalizedThreadID = normalizedInterruptIdentifier(threadId) else {
            return
        }

        let normalizedEffort = effort.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedEffort.isEmpty else {
            clearThreadReasoningEffortOverride(for: normalizedThreadID)
            return
        }

        mutateThreadRuntimeOverride(for: normalizedThreadID) { override in
            override.reasoningEffort = normalizedEffort
            override.overridesReasoning = true
        }
    }

    func clearThreadReasoningEffortOverride(for threadId: String?) {
        guard let normalizedThreadID = normalizedInterruptIdentifier(threadId) else {
            return
        }

        mutateThreadRuntimeOverride(for: normalizedThreadID) { override in
            override.reasoningEffort = nil
            override.overridesReasoning = false
        }
    }

    func setSelectedServiceTier(_ serviceTier: CodexServiceTier?) {
        selectedServiceTier = normalizedServiceTierForSelectedModel(serviceTier)
        persistRuntimeSelections()
    }

    func setThreadServiceTierOverride(_ serviceTier: CodexServiceTier?, for threadId: String?) {
        guard let normalizedThreadID = normalizedInterruptIdentifier(threadId) else {
            return
        }

        let normalizedServiceTier = normalizedServiceTierForSelectedModel(serviceTier)
        mutateThreadRuntimeOverride(for: normalizedThreadID) { override in
            override.serviceTierRawValue = normalizedServiceTier?.rawValue
            override.overridesServiceTier = true
        }
    }

    func clearThreadServiceTierOverride(for threadId: String?) {
        guard let normalizedThreadID = normalizedInterruptIdentifier(threadId) else {
            return
        }

        mutateThreadRuntimeOverride(for: normalizedThreadID) { override in
            override.serviceTierRawValue = nil
            override.overridesServiceTier = false
        }
    }

    func applyThreadRuntimeOverride(_ runtimeOverride: CodexThreadRuntimeOverride?, to threadId: String?) {
        guard let normalizedThreadID = normalizedInterruptIdentifier(threadId) else {
            return
        }

        guard let runtimeOverride, !runtimeOverride.isEmpty else {
            threadRuntimeOverridesByThreadID.removeValue(forKey: normalizedThreadID)
            persistThreadRuntimeOverrides()
            return
        }

        threadRuntimeOverridesByThreadID[normalizedThreadID] = runtimeOverride
        persistThreadRuntimeOverrides()
    }

    func setSelectedAccessMode(_ accessMode: CodexAccessMode) {
        selectedAccessMode = accessMode
        persistRuntimeSelections()
    }

    func selectedModelOption() -> CodexModelOption? {
        selectedModelOption(from: availableModels)
    }

    func selectedGitWriterModelOption() -> CodexModelOption? {
        selectedGitWriterModelOption(from: availableModels)
    }

    func selectedModelSupportsServiceTier(_ serviceTier: CodexServiceTier) -> Bool {
        selectedModelOption()?.supportsServiceTier(serviceTier) == true
    }

    func gitWriterModelIdentifier() -> String? {
        selectedGitWriterModelOption()?.model
    }

    func supportedReasoningEffortsForSelectedModel() -> [CodexReasoningEffortOption] {
        selectedModelOption()?.supportedReasoningEfforts ?? []
    }

    func isThreadReasoningEffortOverridden(_ threadId: String?) -> Bool {
        guard let threadOverride = threadRuntimeOverride(for: threadId),
              threadOverride.overridesReasoning,
              let selectedReasoning = threadOverride.reasoningEffort else {
            return false
        }

        let supportedReasoningEfforts = Set(
            supportedReasoningEffortsForSelectedModel().map(\.reasoningEffort)
        )
        return supportedReasoningEfforts.contains(selectedReasoning)
    }

    func isThreadServiceTierOverridden(_ threadId: String?) -> Bool {
        threadRuntimeOverride(for: threadId)?.overridesServiceTier == true
    }

    func selectedReasoningEffortForSelectedModel(threadId: String? = nil) -> String? {
        guard let model = selectedModelOption() else {
            return selectedReasoningEffort ?? RuntimeSelectionDefaults.reasoningEffort
        }

        let supported = Set(model.supportedReasoningEfforts.map { $0.reasoningEffort })
        guard !supported.isEmpty else {
            return nil
        }

        if let threadOverride = threadRuntimeOverride(for: threadId),
           threadOverride.overridesReasoning,
           let selected = threadOverride.reasoningEffort,
           supported.contains(selected) {
            return selected
        }

        if let selected = selectedReasoningEffort,
           supported.contains(selected) {
            return selected
        }

        if let defaultEffort = model.defaultReasoningEffort,
           supported.contains(defaultEffort) {
            return defaultEffort
        }

        if supported.contains("medium") {
            return "medium"
        }

        return model.supportedReasoningEfforts.first?.reasoningEffort
    }

    func runtimeModelIdentifierForTurn() -> String? {
        selectedModelOption()?.model ?? selectedModelId ?? RuntimeSelectionDefaults.modelId
    }

    func effectiveServiceTier(for threadId: String? = nil) -> CodexServiceTier? {
        let candidate: CodexServiceTier?
        if let threadOverride = threadRuntimeOverride(for: threadId),
           threadOverride.overridesServiceTier {
            candidate = threadOverride.serviceTier
        } else {
            candidate = selectedServiceTier
        }

        guard let candidate else {
            return nil
        }
        return selectedModelSupportsServiceTier(candidate) ? candidate : nil
    }

    func runtimeServiceTierForTurn(threadId: String? = nil) -> String? {
        guard supportsServiceTier else {
            return nil
        }
        return effectiveServiceTier(for: threadId)?.rawValue
    }

    // Copies per-chat runtime overrides forward when we continue an archived thread.
    func inheritThreadRuntimeOverrides(from sourceThreadId: String?, to destinationThreadId: String?) {
        guard let normalizedSourceThreadID = normalizedInterruptIdentifier(sourceThreadId),
              let normalizedDestinationThreadID = normalizedInterruptIdentifier(destinationThreadId),
              normalizedSourceThreadID != normalizedDestinationThreadID else {
            return
        }

        guard let sourceOverride = threadRuntimeOverridesByThreadID[normalizedSourceThreadID] else {
            applyThreadRuntimeOverride(nil, to: normalizedDestinationThreadID)
            return
        }

        applyThreadRuntimeOverride(sourceOverride, to: normalizedDestinationThreadID)
    }

    func handleModelListFailure(_ error: Error) {
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = message.isEmpty ? "Unable to load models" : message
        modelsErrorMessage = normalized
        debugRuntimeLog("model/list failed: \(normalized)")
    }

    func normalizedServiceTierForSelectedModel(_ serviceTier: CodexServiceTier?) -> CodexServiceTier? {
        guard let serviceTier else {
            return nil
        }
        guard let selectedModel = selectedModelOption() else {
            return serviceTier
        }
        return selectedModel.supportsServiceTier(serviceTier) ? serviceTier : nil
    }
}

extension CodexService {
    // Centralizes thread-override mutation so empty records never linger in storage.
    func mutateThreadRuntimeOverride(
        for threadId: String,
        mutate: (inout CodexThreadRuntimeOverride) -> Void
    ) {
        var currentOverride = threadRuntimeOverridesByThreadID[threadId] ?? CodexThreadRuntimeOverride(
            reasoningEffort: nil,
            serviceTierRawValue: nil,
            overridesReasoning: false,
            overridesServiceTier: false
        )

        mutate(&currentOverride)

        if currentOverride.isEmpty {
            threadRuntimeOverridesByThreadID.removeValue(forKey: threadId)
        } else {
            threadRuntimeOverridesByThreadID[threadId] = currentOverride
        }

        persistThreadRuntimeOverrides()
    }

    func normalizeRuntimeSelectionsAfterModelsUpdate() {
        guard !availableModels.isEmpty else {
            if selectedModelId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true {
                selectedModelId = nil
            }
            if selectedReasoningEffort?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true {
                selectedReasoningEffort = nil
            }
            persistRuntimeSelections()
            return
        }

        let resolvedModel = selectedModelOption(from: availableModels) ?? fallbackModel(from: availableModels)
        selectedModelId = resolvedModel?.id
        hasPersistedSelectedModelId = resolvedModel != nil

        if let resolvedModel {
            let supported = Set(resolvedModel.supportedReasoningEfforts.map { $0.reasoningEffort })
            if supported.isEmpty {
                selectedReasoningEffort = nil
            } else if let selectedReasoningEffort,
                      supported.contains(selectedReasoningEffort) {
                // Keep current reasoning.
            } else if let modelDefault = resolvedModel.defaultReasoningEffort,
                      supported.contains(modelDefault) {
                selectedReasoningEffort = modelDefault
            } else if supported.contains("medium") {
                selectedReasoningEffort = "medium"
            } else {
                selectedReasoningEffort = resolvedModel.supportedReasoningEfforts.first?.reasoningEffort
            }

            if let selectedServiceTier,
               !resolvedModel.supportsServiceTier(selectedServiceTier) {
                self.selectedServiceTier = nil
            }
        } else {
            selectedReasoningEffort = nil
            selectedServiceTier = nil
        }

        if let selectedGitWriterModelId,
           !availableModels.contains(where: {
               $0.id == selectedGitWriterModelId || $0.model == selectedGitWriterModelId
           }) {
            self.selectedGitWriterModelId = nil
        }

        persistRuntimeSelections()
    }

    func selectedModelOption(from models: [CodexModelOption]) -> CodexModelOption? {
        guard !models.isEmpty else {
            return nil
        }

        if let selectedModelId,
           let directMatch = models.first(where: { $0.id == selectedModelId || $0.model == selectedModelId }) {
            return directMatch
        }

        return nil
    }

    func selectedGitWriterModelOption(
        from models: [CodexModelOption],
        explicitModelId: String? = nil
    ) -> CodexModelOption? {
        guard !models.isEmpty else {
            return nil
        }

        let savedSelection = explicitModelId ?? selectedGitWriterModelId
        if let savedSelection,
           let directMatch = models.first(where: { $0.id == savedSelection || $0.model == savedSelection }) {
            return directMatch
        }

        if let miniModel = models.first(where: { $0.id == "gpt-5.4-mini" || $0.model == "gpt-5.4-mini" }) {
            return miniModel
        }

        if let runtimeSelected = selectedModelOption(from: models) {
            return runtimeSelected
        }

        return fallbackModel(from: models)
    }

    func fallbackModel(from models: [CodexModelOption]) -> CodexModelOption? {
        // Prefer GPT-5.5 when the bridge advertises it; the rest of the app treats
        // it as the canonical default regardless of the bridge's `isDefault` flag.
        if let preferred = models.first(where: {
            $0.id.lowercased() == "gpt-5.5" || $0.model.lowercased() == "gpt-5.5"
        }) {
            return preferred
        }
        if let defaultModel = models.first(where: { $0.isDefault }) {
            return defaultModel
        }
        return models.first
    }

    func persistRuntimeSelections() {
        if let selectedModelId, !selectedModelId.isEmpty, hasPersistedSelectedModelId {
            defaults.set(selectedModelId, forKey: Self.selectedModelIdDefaultsKey)
        } else {
            defaults.removeObject(forKey: Self.selectedModelIdDefaultsKey)
        }

        if let selectedGitWriterModelId, !selectedGitWriterModelId.isEmpty {
            defaults.set(selectedGitWriterModelId, forKey: Self.selectedGitWriterModelIdDefaultsKey)
        } else {
            defaults.removeObject(forKey: Self.selectedGitWriterModelIdDefaultsKey)
        }

        if let selectedReasoningEffort, !selectedReasoningEffort.isEmpty {
            defaults.set(selectedReasoningEffort, forKey: Self.selectedReasoningEffortDefaultsKey)
        } else {
            defaults.removeObject(forKey: Self.selectedReasoningEffortDefaultsKey)
        }

        if let selectedServiceTier {
            defaults.set(selectedServiceTier.rawValue, forKey: Self.selectedServiceTierDefaultsKey)
        } else {
            defaults.removeObject(forKey: Self.selectedServiceTierDefaultsKey)
        }

        defaults.set(selectedAccessMode.rawValue, forKey: Self.selectedAccessModeDefaultsKey)
        persistThreadRuntimeOverrides()
    }

    func persistThreadRuntimeOverrides() {
        guard !threadRuntimeOverridesByThreadID.isEmpty,
              let encodedOverrides = try? encoder.encode(threadRuntimeOverridesByThreadID) else {
            defaults.removeObject(forKey: macScopedDefaultsKey(Self.threadRuntimeOverridesDefaultsKey))
            return
        }

        defaults.set(encodedOverrides, forKey: macScopedDefaultsKey(Self.threadRuntimeOverridesDefaultsKey))
    }
}
