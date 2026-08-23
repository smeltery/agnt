package com.smeltery.agnt.mobile.ui.turn

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.smeltery.agnt.mobile.core.model.CodexFuzzyFileMatch
import com.smeltery.agnt.mobile.core.model.CodexMessage
import com.smeltery.agnt.mobile.core.model.CodexPluginMetadata
import com.smeltery.agnt.mobile.core.transport.ConnectionState
import com.smeltery.agnt.mobile.data.CodexRepository
import com.smeltery.agnt.mobile.services.agent.threads.CodexLookupService
import com.smeltery.agnt.mobile.services.agent.threads.isPluginListUnsupported
import com.smeltery.agnt.mobile.ui.turn.autocomplete.SkillAutocompleteSuggestion
import com.smeltery.agnt.mobile.ui.turn.autocomplete.TurnComposerAutocompleteState
import com.smeltery.agnt.mobile.ui.turn.autocomplete.buildComposerAutocompleteState
import com.smeltery.agnt.mobile.ui.turn.autocomplete.extractThreadFileAutocompleteCandidates
import com.smeltery.agnt.mobile.ui.turn.autocomplete.isPluginAutocompleteQuery
import com.smeltery.agnt.mobile.ui.turn.autocomplete.loadSkillAutocompleteSuggestions
import com.smeltery.agnt.mobile.ui.turn.composer.ComposerMentionKind
import com.smeltery.agnt.mobile.ui.turn.composer.TrailingComposerMentionParse
import com.smeltery.agnt.mobile.ui.turn.composer.TurnComposerTrailingTokens

internal data class TurnConversationAutocompleteState(
    val trailingToken: TrailingComposerMentionParse?,
    val autocompleteState: TurnComposerAutocompleteState?,
)

@Composable
internal fun rememberTurnConversationAutocompleteState(
    threadId: String,
    repository: CodexRepository,
    lookupService: CodexLookupService,
    ready: Boolean,
    connectionState: ConnectionState,
    activeThreadCwd: String?,
    messages: List<CodexMessage>,
    draft: String,
    isThreadRunning: Boolean,
): TurnConversationAutocompleteState {
    var availableSkills by remember(threadId) { mutableStateOf<List<SkillAutocompleteSuggestion>>(emptyList()) }
    var availablePlugins by remember(threadId) { mutableStateOf<List<CodexPluginMetadata>>(emptyList()) }
    var pluginAutocompleteLoading by remember(threadId) { mutableStateOf(false) }
    var cachedPluginSearchIndexByRoot by remember(repository) { mutableStateOf<Map<String, List<CodexPluginMetadata>>>(emptyMap()) }
    var unsupportedPluginAutocompleteRoots by remember(repository) { mutableStateOf<Set<String>>(emptySet()) }
    var availableFileMatches by remember(threadId) {
        mutableStateOf<List<CodexFuzzyFileMatch>>(emptyList())
    }

    LaunchedEffect(threadId, ready, connectionState, activeThreadCwd) {
        if (!ready || connectionState !is ConnectionState.Connected) {
            availableSkills = emptyList()
            return@LaunchedEffect
        }
        availableSkills =
            runCatching {
                loadSkillAutocompleteSuggestions(repository, activeThreadCwd)
            }.getOrDefault(emptyList())
    }

    val fileAutocompleteCandidates =
        remember(messages) {
            extractThreadFileAutocompleteCandidates(messages)
        }
    val trailingToken =
        remember(draft) { TurnComposerTrailingTokens.parseTrailingToken(draft) }

    LaunchedEffect(
        threadId,
        ready,
        connectionState,
        activeThreadCwd,
        trailingToken?.payload?.kind,
        trailingToken?.payload?.semanticValue,
    ) {
        val parse = trailingToken
        if (!ready || connectionState !is ConnectionState.Connected || parse?.payload?.kind != ComposerMentionKind.File) {
            availableFileMatches = emptyList()
            return@LaunchedEffect
        }
        val query = parse.payload.semanticValue.trim()
        val cwd = activeThreadCwd?.trim()?.takeIf { it.isNotEmpty() }
        if (cwd.isNullOrEmpty() || query.isEmpty()) {
            availableFileMatches = emptyList()
            return@LaunchedEffect
        }
        availableFileMatches =
            runCatching {
                lookupService.fuzzyFileSearch(query = query, roots = listOf(cwd))
            }.getOrDefault(emptyList())
    }

    LaunchedEffect(
        threadId,
        ready,
        connectionState,
        activeThreadCwd,
        trailingToken?.payload?.kind,
        trailingToken?.payload?.semanticValue,
    ) {
        val parse = trailingToken
        val shouldLoadPlugins =
            parse?.payload?.kind == ComposerMentionKind.Plugin ||
                (parse?.payload?.kind == ComposerMentionKind.File && isPluginAutocompleteQuery(parse.payload.semanticValue))
        if (!ready || connectionState !is ConnectionState.Connected || !shouldLoadPlugins) {
            availablePlugins = emptyList()
            pluginAutocompleteLoading = false
            return@LaunchedEffect
        }
        val cwd = activeThreadCwd?.trim()?.takeIf { it.isNotEmpty() }
        if (cwd.isNullOrEmpty()) {
            availablePlugins = emptyList()
            pluginAutocompleteLoading = false
            return@LaunchedEffect
        }
        cachedPluginSearchIndexByRoot[cwd]?.let { cached ->
            availablePlugins = cached
            pluginAutocompleteLoading = false
            return@LaunchedEffect
        }
        if (unsupportedPluginAutocompleteRoots.contains(cwd)) {
            availablePlugins = emptyList()
            pluginAutocompleteLoading = false
            return@LaunchedEffect
        }
        pluginAutocompleteLoading = true
        runCatching {
            lookupService.listPlugins(cwds = listOf(cwd), forceReload = false)
        }.onSuccess { plugins ->
            cachedPluginSearchIndexByRoot = cachedPluginSearchIndexByRoot + (cwd to plugins)
            availablePlugins = plugins
        }.onFailure { error ->
            if (isPluginListUnsupported(error)) {
                unsupportedPluginAutocompleteRoots = unsupportedPluginAutocompleteRoots + cwd
            }
            availablePlugins = emptyList()
        }
        pluginAutocompleteLoading = false
    }

    val autocompleteState =
        remember(
            trailingToken,
            availableSkills,
            availablePlugins,
            pluginAutocompleteLoading,
            fileAutocompleteCandidates,
            availableFileMatches,
            isThreadRunning,
        ) {
            buildComposerAutocompleteState(
                parse = trailingToken,
                skillSuggestions = availableSkills,
                pluginSuggestions = availablePlugins,
                fileCandidates = fileAutocompleteCandidates,
                fileMatches = availableFileMatches,
                isThreadRunning = isThreadRunning,
                isPluginLoading = pluginAutocompleteLoading,
            )
        }

    return TurnConversationAutocompleteState(
        trailingToken = trailingToken,
        autocompleteState = autocompleteState,
    )
}
