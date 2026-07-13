// FILE: CodexService+Discovery.swift
// Purpose: Lists runtime-discovered files, skills, and plugins for composer autocomplete.
// Layer: Service Extension
// Exports: CodexService discovery APIs and decoders
// Depends on: Foundation, JSONValue, CodexFuzzyFileMatch, CodexSkillMetadata, CodexPluginMetadata

import Foundation

extension CodexService {
    // Queries server-side fuzzy file search using stable RPC (non-experimental).
    func fuzzyFileSearch(
        query: String,
        roots: [String],
        cancellationToken: String?
    ) async throws -> [CodexFuzzyFileMatch] {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedQuery.isEmpty else {
            return []
        }

        let normalizedRoots = roots
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !normalizedRoots.isEmpty else {
            return []
        }

        let normalizedToken = cancellationToken?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let tokenValue = (normalizedToken?.isEmpty == false) ? normalizedToken : nil

        let params: JSONValue = .object([
            "query": .string(normalizedQuery),
            "roots": .array(normalizedRoots.map { .string($0) }),
            "cancellationToken": tokenValue.map(JSONValue.string) ?? .null,
        ])

        let response = try await sendRequest(method: "fuzzyFileSearch", params: params)

        guard let decodedFiles = decodeFuzzyFileMatches(from: response.result) else {
            throw CodexServiceError.invalidResponse("fuzzyFileSearch response missing result.files")
        }

        return decodedFiles.map { match in
            let normalizedPath = normalizeFuzzyFilePath(path: match.path, root: match.root)
            return CodexFuzzyFileMatch(
                root: match.root,
                path: normalizedPath,
                fileName: match.fileName,
                score: match.score,
                indices: match.indices
            )
        }
    }

    // Loads available skills for one or more roots with shape-fallback compatibility.
    func listSkills(
        cwds: [String]?,
        forceReload: Bool = false
    ) async throws -> [CodexSkillMetadata] {
        let normalizedCwds = (cwds ?? [])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        var paramsObject: RPCObject = [:]
        if !normalizedCwds.isEmpty {
            paramsObject["cwds"] = .array(normalizedCwds.map { .string($0) })
        }
        if forceReload {
            paramsObject["forceReload"] = .bool(true)
        }

        let response: RPCMessage
        do {
            response = try await sendRequest(method: "skills/list", params: .object(paramsObject))
        } catch {
            guard !normalizedCwds.isEmpty,
                  shouldRetrySkillsListWithCwdFallback(error) else {
                throw error
            }

            var fallbackParams: RPCObject = ["cwd": .string(normalizedCwds[0])]
            if forceReload {
                fallbackParams["forceReload"] = .bool(true)
            }
            response = try await sendRequest(method: "skills/list", params: .object(fallbackParams))
        }

        guard let decodedSkills = decodeSkillMetadata(from: response.result) else {
            throw CodexServiceError.invalidResponse("skills/list response missing result.data[].skills")
        }

        var allSkills = decodedSkills
        if !normalizedCwds.isEmpty {
            var globalParams: RPCObject = [:]
            if forceReload {
                globalParams["forceReload"] = .bool(true)
            }
            // Some runtimes return only cwd-scoped skills when `cwds` is present; merge the
            // global list so personal skills remain discoverable from project threads.
            if let globalResponse = try? await sendRequest(method: "skills/list", params: .object(globalParams)),
               let globalSkills = decodeSkillMetadata(from: globalResponse.result) {
                allSkills.append(contentsOf: globalSkills)
            }
        }

        let dedupedByName = Dictionary(grouping: allSkills) { $0.normalizedName }
            .compactMap { _, bucket -> CodexSkillMetadata? in
                bucket.first(where: { $0.enabled }) ?? bucket.first
            }
            .filter { !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        return dedupedByName
    }

    // Loads Codex app-server plugins and returns entries usable as `@plugin` mentions.
    func listPlugins(
        cwds: [String]?,
        forceReload: Bool = false
    ) async throws -> [CodexPluginMetadata] {
        let normalizedCwds = (cwds ?? [])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        var paramsObject: RPCObject = [:]
        if !normalizedCwds.isEmpty {
            paramsObject["cwds"] = .array(normalizedCwds.map { .string($0) })
        }
        if forceReload {
            paramsObject["forceReload"] = .bool(true)
        }

        let response = try await sendRequest(method: "plugin/list", params: .object(paramsObject))

        guard let decodedPlugins = decodePluginMetadata(from: response.result) else {
            throw CodexServiceError.invalidResponse("plugin/list response missing result.marketplaces[].plugins")
        }

        let mentionablePlugins = decodedPlugins.filter(\.isAvailableForMention)
        let dedupedByPath = Dictionary(grouping: mentionablePlugins) { $0.mentionPath }
            .compactMap { _, bucket -> CodexPluginMetadata? in
                bucket.first
            }
            .filter { !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted { $0.displayTitle.localizedCaseInsensitiveCompare($1.displayTitle) == .orderedAscending }

        return dedupedByPath
    }

    // Parses `result.files` so tests can validate decoding without transport wiring.
    func decodeFuzzyFileMatches(from result: JSONValue?) -> [CodexFuzzyFileMatch]? {
        guard let resultObject = result?.objectValue,
              let filesValue = resultObject["files"] else {
            return nil
        }

        return decodeModel([CodexFuzzyFileMatch].self, from: filesValue)
    }

    // Parses skills/list payloads from both bucketed and flat server response shapes.
    func decodeSkillMetadata(from result: JSONValue?) -> [CodexSkillMetadata]? {
        guard let resultObject = result?.objectValue else {
            return nil
        }

        var collectedSkills: [CodexSkillMetadata] = []
        var hasSkillContainer = false

        if let dataItems = resultObject["data"]?.arrayValue {
            hasSkillContainer = true
            for item in dataItems {
                guard let itemObject = item.objectValue else {
                    continue
                }
                if let skillsValue = itemObject["skills"],
                   let decodedSkills = decodeModel([CodexSkillMetadata].self, from: skillsValue) {
                    collectedSkills.append(contentsOf: decodedSkills)
                }
            }

            if collectedSkills.isEmpty,
               let decodedSkills = decodeModel([CodexSkillMetadata].self, from: .array(dataItems)) {
                collectedSkills.append(contentsOf: decodedSkills)
            }
        }

        if collectedSkills.isEmpty,
           let skillsValue = resultObject["skills"],
           let decodedSkills = decodeModel([CodexSkillMetadata].self, from: skillsValue) {
            hasSkillContainer = true
            collectedSkills.append(contentsOf: decodedSkills)
        } else if resultObject["skills"] != nil {
            hasSkillContainer = true
        }

        return hasSkillContainer ? collectedSkills : nil
    }

    // Parses Codex app-server plugin/list marketplace payloads.
    func decodePluginMetadata(from result: JSONValue?) -> [CodexPluginMetadata]? {
        guard let resultObject = result?.objectValue,
              let response = decodeModel(CodexPluginListResponse.self, from: .object(resultObject)) else {
            return nil
        }

        var plugins: [CodexPluginMetadata] = []
        for marketplace in response.marketplaces {
            let marketplaceName = marketplace.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !marketplaceName.isEmpty else {
                continue
            }

            for plugin in marketplace.plugins {
                let pluginName = plugin.name.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !pluginName.isEmpty else {
                    continue
                }

                plugins.append(
                    CodexPluginMetadata(
                        id: plugin.id,
                        name: pluginName,
                        marketplaceName: marketplaceName,
                        marketplacePath: marketplace.path,
                        displayName: plugin.interface?.displayName,
                        shortDescription: plugin.interface?.shortDescription,
                        installed: plugin.installed,
                        enabled: plugin.enabled,
                        installPolicy: plugin.installPolicy
                    )
                )
            }
        }

        return plugins
    }

    func shouldRetrySkillsListWithCwdFallback(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        guard rpcError.code == -32600 || rpcError.code == -32602 else {
            return false
        }

        let message = rpcError.message.lowercased()
        return message.contains("invalid")
            || message.contains("unknown field")
            || message.contains("unrecognized field")
            || message.contains("missing field")
            || message.contains("expected")
            || message.contains("cwds")
    }

    // Converts absolute match paths to root-relative output when older servers return full paths.
    func normalizeFuzzyFilePath(path: String, root: String) -> String {
        let trimmedPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPath.isEmpty else {
            return path
        }

        let normalizedRoot = normalizedFuzzyRootPath(root)
        guard !normalizedRoot.isEmpty else {
            return trimmedPath
        }

        if normalizedRoot == "/" {
            return trimmedPath.hasPrefix("/") ? String(trimmedPath.dropFirst()) : trimmedPath
        }

        let rootPrefix = normalizedRoot.hasSuffix("/") ? normalizedRoot : "\(normalizedRoot)/"
        if trimmedPath.hasPrefix(rootPrefix) {
            return String(trimmedPath.dropFirst(rootPrefix.count))
        }

        return trimmedPath
    }
}

private extension CodexService {
    func normalizedFuzzyRootPath(_ root: String) -> String {
        var normalized = root.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            return ""
        }

        if normalized == "/" {
            return normalized
        }

        while normalized.hasSuffix("/") {
            normalized.removeLast()
        }

        return normalized.isEmpty ? "/" : normalized
    }
}
