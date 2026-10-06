import Foundation

enum CodexServiceError: Error { case invalidInput(String), disconnected }
@MainActor final class CodexService {
    var supportsRuntimeSettingsSync = true
    var runtimeSettingsProviderId: String? = "codex"
    var isConnected = true
    var isInitialized = true
    var activeThreadId: String? = "task"
    var lastErrorMessage: String?
    var threadRuntimeOverridesByThreadID: [String: CodexThreadRuntimeOverride] = [:]
    var runtimeSettingsUpdateTasks: [String: Task<Void, Never>] = [:]
    var runtimeSettingsUpdateIDs: [String: UUID] = [:]
    var retiredRuntimeSettingsEpochs: [String: Set<String>] = [:]
    var runtimeSettingsUpdateErrors: [String: String] = [:]
    var confirmedRuntimeSettings: [String: CodexRuntimeSettings] = [:]
    var requests: [RPCObject] = []
    var responses: [CheckedContinuation<RPCMessage, Error>] = []
    func threadRuntimeOverride(for id: String) -> CodexThreadRuntimeOverride? { threadRuntimeOverridesByThreadID[id] }
    func applyThreadRuntimeOverride(_ value: CodexThreadRuntimeOverride?, to id: String) { threadRuntimeOverridesByThreadID[id] = value }
    func runtimeModelIdentifierForTurn(threadId: String) -> String? { threadRuntimeOverride(for: threadId)?.modelId }
    func selectedReasoningEffortForSelectedModel(threadId: String) -> String? { threadRuntimeOverride(for: threadId)?.reasoningEffort }
    func effectiveServiceTier(for id: String) -> CodexServiceTier? { threadRuntimeOverride(for: id)?.serviceTier }
    func inheritsOwnerServiceTier(for id: String?) -> Bool { id.flatMap { threadRuntimeOverride(for: $0)?.overridesServiceTier } != true }
    func ensureThreadResumed(threadId: String) async throws {}
    func decodeModel<T: Decodable>(_ type: T.Type, from value: JSONValue) -> T? { try? JSONDecoder().decode(type, from: JSONEncoder().encode(value)) }
    func sendRequest(method: String, params: JSONValue) async throws -> RPCMessage {
        precondition(method == "thread/settings/update")
        requests.append(params.objectValue!)
        return try await withCheckedThrowingContinuation { responses.append($0) }
    }
    func acknowledge(_ index: Int, _ settings: CodexRuntimeSettings) throws {
        let value = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(settings))
        responses[index].resume(returning: RPCMessage(id: nil, result: .object(["runtimeSettings": value])))
    }
}

@main struct RuntimeSettingsChecks {
    @MainActor static func until(_ predicate: () -> Bool) async throws {
        for _ in 0..<1000 {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(1))
        }
        fatalError("Settings queue timed out")
    }
    static func settings(_ revision: Int, effort: String = "high") -> CodexRuntimeSettings {
        CodexRuntimeSettings(model: "chosen", reasoningEffort: effort, serviceTier: nil,
            revision: revision, updatedAt: Double(revision), epoch: "epoch", source: "runtime")
    }
    @MainActor static func main() async throws {
        let catalog = try JSONDecoder().decode(CodexModelOption.self, from: Data(
            #"{"id":"model","serviceTiers":[{"id":"priority","name":"Fast"},{"id":"flex","name":"Flexible"}]}"#.utf8))
        precondition(catalog.serviceTiers.map(\.rawValue) == ["priority", "flex"])
        let emptyCatalog = try JSONDecoder().decode(CodexModelOption.self, from: Data(
            #"{"id":"gpt-5.5","serviceTiers":[]}"#.utf8))
        precondition(!emptyCatalog.supportsFastMode)
        precondition(CodexServiceTier(rawValue: "fast") == .fast)
        let service = CodexService()
        service.applyConfirmedRuntimeSettings(settings(1), threadId: "task")
        service.threadRuntimeOverridesByThreadID["task"]!.serviceTierRawValue = "fast"
        service.queueThreadRuntimeSettingsUpdate(threadId: "task", fields: ["serviceTier"])
        try await until { service.responses.count == 1 }
        precondition(service.requests[0]["serviceTier"] == .string("priority"))
        service.threadRuntimeOverridesByThreadID["task"]!.reasoningEffort = "low"
        service.queueThreadRuntimeSettingsUpdate(threadId: "task", fields: ["effort"])
        try service.acknowledge(0, settings(2))
        try await until { service.responses.count == 2 }
        precondition(service.requests[1] == ["threadId": .string("task"), "effort": .string("low")])
        try service.acknowledge(1, settings(3, effort: "low"))
        try await service.waitForRuntimeSettingsUpdate(threadId: "task")
        precondition(service.threadRuntimeOverride(for: "task")!.pendingRuntimeSettings.isEmpty)
        service.applyConfirmedRuntimeSettings(settings(2), threadId: "task")
        precondition(service.threadRuntimeOverride(for: "task")!.reasoningEffort == "low")

        service.queueThreadRuntimeSettingsUpdate(threadId: "task", fields: ["effort"])
        try await until { service.responses.count == 3 }
        service.responses[2].resume(throwing: CodexServiceError.invalidInput("rejected"))
        try await until { service.runtimeSettingsUpdateTasks["task"] == nil }
        precondition(service.runtimeSettingsUpdateErrors["task"] != nil)
        precondition(!service.threadRuntimeOverride(for: "task")!.pendingRuntimeSettings.isEmpty)

        let other = CodexService()
        other.runtimeSettingsProviderId = "claude"
        other.queueThreadRuntimeSettingsUpdate(threadId: "task")
        precondition(other.requests.isEmpty && other.threadRuntimeOverridesByThreadID.isEmpty)
        print("Runtime settings race checks passed")
    }
}
