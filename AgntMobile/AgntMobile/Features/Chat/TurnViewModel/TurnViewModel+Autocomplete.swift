// FILE: TurnViewModel+Autocomplete.swift
// Purpose: Skill, plugin, and file autocomplete filtering helpers.
// Layer: View Model

import Foundation

extension TurnViewModel {
    // Filters pre-indexed skills while ranking name matches above description-only matches.
    func filteredSkillAutocompleteItems(
        for query: String,
        indexedSkills: [TurnSkillSearchIndexEntry]
    ) -> [CodexSkillMetadata] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else {
            return Array(indexedSkills.lazy.map(\.skill).prefix(maxSkillAutocompleteItems))
        }

        let filtered = indexedSkills.enumerated().compactMap { offset, entry -> (Int, Int, CodexSkillMetadata)? in
            guard let score = entry.matchScore(for: needle) else {
                return nil
            }
            return (score, offset, entry.skill)
        }
            .sorted { lhs, rhs in
                if lhs.0 != rhs.0 {
                    return lhs.0 < rhs.0
                }
                return lhs.1 < rhs.1
            }
            .map { $0.2 }
        return Array(filtered.prefix(maxSkillAutocompleteItems))
    }

    func shouldRefreshSkillAutocompleteMiss(
        query: String,
        cachedItems: [CodexSkillMetadata],
        cacheKey: String
    ) -> Bool {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedQuery.isEmpty,
              cachedItems.isEmpty,
              !unsupportedSkillsAutocompleteRoots.contains(cacheKey),
              !forceRefreshedSkillMissKeys.contains(skillAutocompleteMissRefreshKey(query: trimmedQuery, cacheKey: cacheKey)) else {
            return false
        }

        return true
    }

    func rememberSkillAutocompleteMissRefresh(
        query: String,
        cacheKey: String,
        indexedSkills: [TurnSkillSearchIndexEntry]
    ) {
        let refreshedItems = filteredSkillAutocompleteItems(for: query, indexedSkills: indexedSkills)
        let refreshKey = skillAutocompleteMissRefreshKey(query: query, cacheKey: cacheKey)
        if refreshedItems.isEmpty {
            forceRefreshedSkillMissKeys.insert(refreshKey)
        } else {
            forceRefreshedSkillMissKeys.remove(refreshKey)
        }
    }

    func clearSkillAutocompleteMissRefreshes(cacheKey: String) {
        let prefix = "\(cacheKey)\u{0}"
        forceRefreshedSkillMissKeys = Set(forceRefreshedSkillMissKeys.filter { !$0.hasPrefix(prefix) })
    }

    func skillAutocompleteMissRefreshKey(query: String, cacheKey: String) -> String {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return "\(cacheKey)\u{0}\(normalizedQuery)"
    }

    func filteredPluginAutocompleteItems(
        for query: String,
        indexedPlugins: [TurnPluginSearchIndexEntry]
    ) -> [CodexPluginMetadata] {
        let needle = CodexPluginMetadata.normalizedDiscoveryText(query)
        let filtered = indexedPlugins.lazy
            .filter { needle.isEmpty || $0.searchBlob.contains(needle) }
            .map(\.plugin)
        return Array(filtered.prefix(maxPluginAutocompleteItems))
    }

    func normalizedAutocompleteRoot(for thread: CodexThread) -> String? {
        thread.gitWorkingDirectory
    }

    func autocompleteCacheKey(forRoot root: String?) -> String {
        root ?? "__global__"
    }

    func fileAutocompleteCancellationToken(for threadID: String) -> String {
        "ios-at-file-\(threadID)"
    }

    // Reuses the stop-button refresh path so queued sends do not trust stale running flags.
}
