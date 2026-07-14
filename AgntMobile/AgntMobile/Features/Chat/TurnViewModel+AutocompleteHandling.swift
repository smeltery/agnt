// FILE: TurnViewModel+AutocompleteHandling.swift
// Purpose: Handles composer autocomplete input changes and selections.
// Layer: View Model Extension
// Exports: TurnViewModel autocomplete handlers
// Depends on: SwiftUI, CodexService, TurnComposer autocomplete models

import SwiftUI

extension TurnViewModel {
    func onInputChangedForFileAutocomplete(
        _ text: String,
        codex: CodexService,
        thread: CodexThread,
        activeTurnID: String?
    ) {
        guard !isComposerInteractionLocked(activeTurnID: activeTurnID),
              codex.isConnected,
              let root = normalizedAutocompleteRoot(for: thread),
              let token = Self.trailingFileAutocompleteToken(in: text) else {
            resetFileAutocompleteState()
            return
        }

        // Keeps a confirmed `@file` mention closed once the user resumes normal prose after it.
        guard !Self.hasClosedConfirmedFileMentionPrefix(
            in: text,
            confirmedMentions: composerMentionedFiles
        ) else {
            resetFileAutocompleteState()
            return
        }

        // Keep one autocomplete namespace visible at a time.
        resetSkillAutocompleteState()
        resetSlashCommandState(clearPendingSelection: true)

        let query = token.query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.count >= 1 else {
            fileAutocompleteDebounceTask?.cancel()
            fileAutocompleteDebounceTask = nil
            fileAutocompleteItems = []
            fileAutocompleteQuery = query
            isFileAutocompleteLoading = false
            isFileAutocompleteVisible = false
            return
        }

        fileAutocompleteQuery = query
        isFileAutocompleteVisible = true
        isFileAutocompleteLoading = true
        fileAutocompleteDebounceTask?.cancel()

        let searchRoots = [root]
        let expectedQuery = query
        let cancellationToken = fileAutocompleteCancellationToken(for: thread.id)

        fileAutocompleteDebounceTask = Task { @MainActor [weak self] in
            guard let self else { return }

            do {
                try await Task.sleep(nanoseconds: fileAutocompleteDebounceNanoseconds)
            } catch {
                return
            }

            guard !Task.isCancelled else { return }

            do {
                let matches = try await codex.fuzzyFileSearch(
                    query: expectedQuery,
                    roots: searchRoots,
                    cancellationToken: cancellationToken
                )
                guard !Task.isCancelled else { return }

                // Drops stale responses if the user already typed another query.
                guard self.fileAutocompleteQuery == expectedQuery else { return }

                self.fileAutocompleteItems = Array(matches.prefix(self.maxFileAutocompleteItems))
                self.isFileAutocompleteLoading = false
                self.isFileAutocompleteVisible = true
            } catch {
                guard self.fileAutocompleteQuery == expectedQuery else { return }
                self.fileAutocompleteItems = []
                self.isFileAutocompleteLoading = false
                self.isFileAutocompleteVisible = false
            }
        }
    }

    // Debounces skill suggestions when input ends with a valid `$query` token.
    func onInputChangedForSkillAutocomplete(
        _ text: String,
        codex: CodexService,
        thread: CodexThread,
        activeTurnID: String?
    ) {
        guard !isComposerInteractionLocked(activeTurnID: activeTurnID),
              codex.isConnected,
              let token = Self.trailingSkillAutocompleteToken(in: text) else {
            resetSkillAutocompleteState()
            return
        }

        // Keep one autocomplete namespace visible at a time.
        resetFileAutocompleteState()
        resetPluginAutocompleteState()
        resetSlashCommandState(clearPendingSelection: true)

        let query = token.query.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedRoot = normalizedAutocompleteRoot(for: thread)
        let cacheKey = autocompleteCacheKey(forRoot: normalizedRoot)
        skillAutocompleteQuery = query
        skillAutocompleteTrigger = String(token.trigger)
        let hasCachedSkillIndex = cachedSkillSearchIndexByRoot[cacheKey] != nil
        let rootIsUnsupported = unsupportedSkillsAutocompleteRoots.contains(cacheKey)
        isSkillAutocompleteLoading = !hasCachedSkillIndex && !rootIsUnsupported
        if let cachedIndex = cachedSkillSearchIndexByRoot[cacheKey] {
            skillAutocompleteItems = filteredSkillAutocompleteItems(for: query, indexedSkills: cachedIndex)
            let shouldRefreshCachedMiss = shouldRefreshSkillAutocompleteMiss(
                query: query,
                cachedItems: skillAutocompleteItems,
                cacheKey: cacheKey
            )
            isSkillAutocompleteLoading = shouldRefreshCachedMiss
            isSkillAutocompleteVisible = !skillAutocompleteItems.isEmpty || shouldRefreshCachedMiss
        } else {
            skillAutocompleteItems = []
            isSkillAutocompleteVisible = isSkillAutocompleteLoading
        }
        skillAutocompleteDebounceTask?.cancel()

        let expectedQuery = query

        skillAutocompleteDebounceTask = Task { @MainActor [weak self] in
            guard let self else { return }

            do {
                try await Task.sleep(nanoseconds: skillAutocompleteDebounceNanoseconds)
            } catch {
                return
            }

            guard !Task.isCancelled else { return }

            do {
                if unsupportedSkillsAutocompleteRoots.contains(cacheKey),
                   cachedSkillSearchIndexByRoot[cacheKey] == nil {
                    guard self.skillAutocompleteQuery == expectedQuery else { return }
                    self.skillAutocompleteItems = []
                    self.isSkillAutocompleteLoading = false
                    self.isSkillAutocompleteVisible = false
                    return
                }

                let indexedSkills: [TurnSkillSearchIndexEntry]
                if let cachedIndex = self.cachedSkillSearchIndexByRoot[cacheKey] {
                    let cachedItems = self.filteredSkillAutocompleteItems(
                        for: expectedQuery,
                        indexedSkills: cachedIndex
                    )
                    if self.shouldRefreshSkillAutocompleteMiss(
                        query: expectedQuery,
                        cachedItems: cachedItems,
                        cacheKey: cacheKey
                    ) {
                        let listedSkills = try await codex.listSkills(
                            cwds: normalizedRoot.map { [$0] },
                            forceReload: true
                        )
                        guard !Task.isCancelled else { return }
                        indexedSkills = listedSkills
                            .filter { $0.enabled }
                            .map(TurnSkillSearchIndexEntry.init(skill:))
                        self.cachedSkillSearchIndexByRoot[cacheKey] = indexedSkills
                        self.rememberSkillAutocompleteMissRefresh(
                            query: expectedQuery,
                            cacheKey: cacheKey,
                            indexedSkills: indexedSkills
                        )
                    } else {
                        indexedSkills = cachedIndex
                    }
                } else {
                    let listedSkills = try await codex.listSkills(
                        cwds: normalizedRoot.map { [$0] },
                        forceReload: false
                    )
                    guard !Task.isCancelled else { return }
                    indexedSkills = listedSkills
                        .filter { $0.enabled }
                        .map(TurnSkillSearchIndexEntry.init(skill:))
                    self.cachedSkillSearchIndexByRoot[cacheKey] = indexedSkills
                    self.clearSkillAutocompleteMissRefreshes(cacheKey: cacheKey)
                }

                guard !Task.isCancelled else { return }
                guard self.skillAutocompleteQuery == expectedQuery else { return }

                self.skillAutocompleteItems = self.filteredSkillAutocompleteItems(
                    for: expectedQuery,
                    indexedSkills: indexedSkills
                )
                self.isSkillAutocompleteLoading = false
                self.isSkillAutocompleteVisible = !self.skillAutocompleteItems.isEmpty
            } catch {
                guard self.skillAutocompleteQuery == expectedQuery else { return }

                if Self.isMethodNotFoundRPCError(error) {
                    self.unsupportedSkillsAutocompleteRoots.insert(cacheKey)
                }

                self.skillAutocompleteItems = []
                self.isSkillAutocompleteLoading = false
                self.isSkillAutocompleteVisible = false
            }
        }
    }

    // Debounces installed Codex plugin suggestions for `@plugin` composer mentions.
    func onInputChangedForPluginAutocomplete(
        _ text: String,
        codex: CodexService,
        thread: CodexThread,
        activeTurnID: String?
    ) {
        guard !isComposerInteractionLocked(activeTurnID: activeTurnID),
              codex.isConnected,
              let root = normalizedAutocompleteRoot(for: thread),
              let token = Self.trailingPluginAutocompleteToken(in: text) else {
            resetPluginAutocompleteState()
            return
        }

        resetSkillAutocompleteState()
        resetSlashCommandState(clearPendingSelection: true)

        let query = token.query.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedRoot = root
        pluginAutocompleteQuery = query
        isPluginAutocompleteVisible = true
        let hasCachedPluginIndex = cachedPluginSearchIndexByRoot[normalizedRoot] != nil
        let rootIsUnsupported = unsupportedPluginsAutocompleteRoots.contains(normalizedRoot)
        isPluginAutocompleteLoading = !hasCachedPluginIndex && !rootIsUnsupported
        if let cachedIndex = cachedPluginSearchIndexByRoot[normalizedRoot] {
            pluginAutocompleteItems = filteredPluginAutocompleteItems(for: query, indexedPlugins: cachedIndex)
            isPluginAutocompleteVisible = !pluginAutocompleteItems.isEmpty
        } else {
            pluginAutocompleteItems = []
        }
        pluginAutocompleteDebounceTask?.cancel()

        let expectedQuery = query

        pluginAutocompleteDebounceTask = Task { @MainActor [weak self] in
            guard let self else { return }

            do {
                try await Task.sleep(nanoseconds: pluginAutocompleteDebounceNanoseconds)
            } catch {
                return
            }

            guard !Task.isCancelled else { return }

            do {
                if unsupportedPluginsAutocompleteRoots.contains(normalizedRoot),
                   cachedPluginSearchIndexByRoot[normalizedRoot] == nil {
                    guard self.pluginAutocompleteQuery == expectedQuery else { return }
                    self.pluginAutocompleteItems = []
                    self.isPluginAutocompleteLoading = false
                    self.isPluginAutocompleteVisible = false
                    return
                }

                let indexedPlugins: [TurnPluginSearchIndexEntry]
                if let cachedIndex = self.cachedPluginSearchIndexByRoot[normalizedRoot] {
                    indexedPlugins = cachedIndex
                } else {
                    let listedPlugins = try await codex.listPlugins(cwds: [normalizedRoot], forceReload: false)
                    guard !Task.isCancelled else { return }
                    indexedPlugins = listedPlugins
                        .map(TurnPluginSearchIndexEntry.init(plugin:))
                    self.cachedPluginSearchIndexByRoot[normalizedRoot] = indexedPlugins
                }

                guard !Task.isCancelled else { return }
                guard self.pluginAutocompleteQuery == expectedQuery else { return }

                self.pluginAutocompleteItems = self.filteredPluginAutocompleteItems(
                    for: expectedQuery,
                    indexedPlugins: indexedPlugins
                )
                self.isPluginAutocompleteLoading = false
                self.isPluginAutocompleteVisible = !self.pluginAutocompleteItems.isEmpty
            } catch {
                guard self.pluginAutocompleteQuery == expectedQuery else { return }

                if Self.isMethodNotFoundRPCError(error) {
                    self.unsupportedPluginsAutocompleteRoots.insert(normalizedRoot)
                }

                self.pluginAutocompleteItems = []
                self.isPluginAutocompleteLoading = false
                self.isPluginAutocompleteVisible = false
            }
        }
    }

    // Replaces `@query` with `@filename` in text and adds chip above input.
    func onSelectFileAutocomplete(_ item: CodexFuzzyFileMatch) {
        clearComposerReviewSelectionIfNeededForNonReviewContent()

        let fullPath = item.path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? item.fileName
            : item.path

        // Replace @query with @filename inline in the text.
        if let updatedInput = Self.replacingTrailingFileAutocompleteToken(
            in: input, with: item.fileName
        ) {
            input = updatedInput
        }

        if !composerMentionedFiles.contains(where: { $0.path == fullPath }) {
            composerMentionedFiles.append(
                TurnComposerMentionedFile(fileName: item.fileName, path: fullPath)
            )
        }
        resetFileAutocompleteState()
    }

    // Replaces `@query` with `@plugin` and stores the app-server mention item for turn/start.
    func onSelectPluginAutocomplete(_ plugin: CodexPluginMetadata) {
        clearComposerReviewSelectionIfNeededForNonReviewContent()

        let normalizedPluginName = plugin.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedMentionPath = plugin.mentionPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedPluginName.isEmpty, !normalizedMentionPath.isEmpty else {
            resetPluginAutocompleteState()
            return
        }

        if let updatedInput = Self.replacingTrailingPluginAutocompleteToken(
            in: input,
            with: normalizedPluginName
        ) {
            input = updatedInput
        }

        if !composerMentionedPlugins.contains(where: { $0.path == normalizedMentionPath }) {
            composerMentionedPlugins.append(
                TurnComposerMentionedPlugin(
                    name: normalizedPluginName,
                    path: normalizedMentionPath,
                    displayName: plugin.displayName
                )
            )
        }

        resetPluginAutocompleteState()
    }

    // Replaces `$query` or `/query` with the selected skill token and stores the turn/start mention.
    func onSelectSkillAutocomplete(_ skill: CodexSkillMetadata) {
        clearComposerReviewSelectionIfNeededForNonReviewContent()

        let normalizedSkillName = skill.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedSkillName.isEmpty else {
            resetSkillAutocompleteState()
            return
        }

        if let updatedInput = Self.replacingTrailingSkillAutocompleteToken(
            in: input, with: normalizedSkillName
        ) {
            input = updatedInput
        }

        let normalizedPath = skill.path?.trimmingCharacters(in: .whitespacesAndNewlines)
        if !composerMentionedSkills.contains(where: { $0.name.caseInsensitiveCompare(normalizedSkillName) == .orderedSame }) {
            composerMentionedSkills.append(
                TurnComposerMentionedSkill(
                    name: normalizedSkillName,
                    path: (normalizedPath?.isEmpty == false) ? normalizedPath : nil,
                    description: skill.description
                )
            )
        }

        resetSkillAutocompleteState()
    }

    // Keeps `/` command discovery separate from @/$ autocomplete while supporting a bare trailing slash.
    func onInputChangedForSlashCommandAutocomplete(
        _ text: String,
        activeTurnID: String?
    ) {
        clearComposerReviewSelectionIfNeededForInput(text)

        guard !isComposerInteractionLocked(activeTurnID: activeTurnID) else {
            resetSlashCommandState(clearPendingSelection: true)
            return
        }

        switch slashCommandPanelState {
        case .codeReviewTargets, .forkDestinations:
            return
        case .hidden, .commands:
            break
        }

        guard let token = Self.trailingSlashCommandToken(in: text) else {
            if case .commands = slashCommandPanelState {
                resetSlashCommandState()
            }
            return
        }

        let matchingCommands = TurnComposerSlashCommand.filtered(matching: token.query)
        guard token.query.isEmpty || !matchingCommands.isEmpty else {
            if case .commands = slashCommandPanelState {
                resetSlashCommandState()
            }
            return
        }

        resetFileAutocompleteState()
        resetSkillAutocompleteState()
        resetPluginAutocompleteState()
        slashCommandPanelState = .commands(query: token.query)
    }

    // Turns the selected slash command into the matching inline composer behavior.
    func onSelectSlashCommand(
        _ command: TurnComposerSlashCommand,
        availableForkDestinations: [TurnComposerForkDestination] = [.local]
    ) {
        switch command {
        case .codeReview:
            removeTrailingSlashCommandTokenFromInputIfNeeded()
            armCodeReviewSelection(command: command, target: nil)
        case .feedback:
            removeTrailingSlashCommandTokenFromInputIfNeeded()
            resetSlashCommandState(clearPendingSelection: true)
        case .fork:
            slashCommandPanelState = .forkDestinations(availableForkDestinations)
        case .goal:
            removeTrailingSlashCommandTokenFromInputIfNeeded()
            resetSlashCommandState(clearPendingSelection: true)
        case .status:
            removeTrailingSlashCommandTokenFromInputIfNeeded()
            resetSlashCommandState(clearPendingSelection: true)
        case .subagents:
            armSubagentsSelection()
        case .compact:
            removeTrailingSlashCommandTokenFromInputIfNeeded()
            resetSlashCommandState(clearPendingSelection: true)
        }
    }
}
