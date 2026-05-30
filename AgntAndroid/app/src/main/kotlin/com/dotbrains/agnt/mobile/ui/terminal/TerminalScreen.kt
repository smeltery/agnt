package com.dotbrains.agnt.mobile.ui.terminal

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dotbrains.agnt.mobile.AppContainer
import com.dotbrains.agnt.mobile.core.terminal.TerminalController
import com.dotbrains.agnt.mobile.core.terminal.TerminalProfile
import com.dotbrains.agnt.mobile.core.terminal.TerminalSnapshot
import com.dotbrains.agnt.mobile.core.terminal.TerminalStatus
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import com.composables.icons.lucide.R as LucideR

/**
 * Full-screen on-device SSH terminal route. Mirrors `TerminalScreen.swift`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(
    onNavigateBack: () -> Unit,
    preferredWorkingDirectory: String? = null,
    controller: TerminalController = AppContainer.terminalController,
) {
    val theme = rememberTerminalTheme()
    val backgroundColor = remember(theme) { Color(android.graphics.Color.parseColor(theme.background)) }
    val coroutineScope = rememberCoroutineScope()

    val snapshots by controller.snapshots.collectAsStateWithLifecycle(initialValue = emptyMap())
    var activeTerminalId by remember { mutableStateOf(TerminalSnapshot.DEFAULT_TERMINAL_ID) }

    var draftProfile by remember { mutableStateOf(controller.loadProfile()) }
    var draftPrivateKey by remember { mutableStateOf(controller.loadPrivateKey()) }
    var draftPassphrase by remember { mutableStateOf(controller.loadPassphrase()) }
    var connectionDraft by remember { mutableStateOf(draftProfile.connectionString) }
    var showEditor by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var fontSize by remember { mutableStateOf(TERMINAL_FONT_SIZE_DEFAULT) }
    var pendingModifier by remember { mutableStateOf<TerminalPendingModifier?>(null) }
    var nativeAvailable by remember { mutableStateOf(true) }
    var bootstrappedIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var userClosedIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var didApplyPreferredCwd by remember { mutableStateOf(false) }

    val activeSnapshot = snapshots[activeTerminalId] ?: TerminalSnapshot.idle(activeTerminalId)

    // Lift the per-terminal Flow chain out of composition: `Flow.filter { }.map { }` allocates
    // a brand-new Flow every recomposition, which churns subscribers downstream. `remember` keys
    // on the inputs that actually change the upstream (activeTerminalId + controller) so the same
    // Flow instance is reused across recompositions.
    val incomingTerminalOutput =
        remember(activeTerminalId, controller) {
            controller.outputEvents
                .filter { it.terminalId == activeTerminalId }
                .map { it.bytes }
        }

    val resolvedProfile by remember {
        derivedStateOf { draftProfile.applyingConnectionString(connectionDraft).normalizedForSave() }
    }
    val hasConnectionConfiguration by remember {
        derivedStateOf {
            resolvedProfile.host.isNotBlank() &&
                resolvedProfile.username.isNotBlank() &&
                controller.hasPrivateKey(draftPrivateKey)
        }
    }
    val isRunning =
        activeSnapshot.status == TerminalStatus.Running ||
            activeSnapshot.status == TerminalStatus.Starting

    fun openTerminalNow(
        targetId: String,
        profile: TerminalProfile,
    ) {
        coroutineScope.launch {
            actionError = null
            val finalProfile = profile.normalizedForSave()
            controller.saveProfile(finalProfile)
            controller.savePrivateKey(draftPrivateKey)
            controller.savePassphrase(draftPassphrase)
            try {
                controller.openTerminal(
                    terminalId = targetId,
                    profile = finalProfile,
                    cols = activeSnapshot.cols,
                    rows = activeSnapshot.rows,
                )
            } catch (error: Throwable) {
                actionError = error.message ?: error::class.java.simpleName
            }
        }
    }

    fun toggleConnection() {
        coroutineScope.launch {
            if (isRunning) {
                userClosedIds = userClosedIds + activeTerminalId
                runCatching { controller.closeTerminal(activeTerminalId) }
                    .onFailure { actionError = it.message }
            } else if (hasConnectionConfiguration) {
                userClosedIds = userClosedIds - activeTerminalId
                openTerminalNow(activeTerminalId, resolvedProfile)
            } else {
                showEditor = true
            }
        }
    }

    fun handleTextInput(text: String) {
        if (text.isEmpty()) return
        val payload =
            when (pendingModifier) {
                TerminalPendingModifier.Ctrl -> {
                    pendingModifier = null
                    applyCtrlModifier(text)
                }
                TerminalPendingModifier.Meta -> {
                    pendingModifier = null
                    applyMetaModifier(text)
                }
                null -> text
            }
        if (activeSnapshot.status != TerminalStatus.Running) return
        coroutineScope.launch {
            runCatching {
                controller.writeInput(activeTerminalId, payload.toByteArray(Charsets.UTF_8))
            }
        }
    }

    fun handleAccessoryAction(action: TerminalAccessoryButton) {
        when (val a = action.action) {
            is TerminalAccessoryAction.Modifier ->
                pendingModifier = if (pendingModifier == a.modifier) null else a.modifier
            is TerminalAccessoryAction.Send -> handleTextInput(a.data)
        }
    }

    LaunchedEffect(activeTerminalId) {
        if (didApplyPreferredCwd && activeTerminalId in bootstrappedIds) return@LaunchedEffect
        if (!didApplyPreferredCwd) {
            didApplyPreferredCwd = true
            preferredWorkingDirectory?.takeIf { it.isNotBlank() }?.let {
                draftProfile = draftProfile.applyingPreferredWorkingDirectoryOverride(it)
            }
        }
        connectionDraft = draftProfile.connectionString
        if (!hasConnectionConfiguration) {
            showEditor = true
            return@LaunchedEffect
        }
        if (activeTerminalId in bootstrappedIds || activeTerminalId in userClosedIds || isRunning) {
            bootstrappedIds = bootstrappedIds + activeTerminalId
            return@LaunchedEffect
        }
        bootstrappedIds = bootstrappedIds + activeTerminalId
        openTerminalNow(activeTerminalId, resolvedProfile)
    }

    val statusLabel = remember(activeSnapshot.status) { activeSnapshot.status.displayTitle }
    val statusTone = remember(activeSnapshot.status) { toneFor(activeSnapshot.status) }
    val errorDetail = (actionError ?: activeSnapshot.errorMessage)?.takeIf { it.isNotBlank() }

    val sessionItems by remember(snapshots, activeTerminalId) {
        derivedStateOf {
            controller
                .knownSnapshots()
                .filter { it.terminalId == activeTerminalId || it.status.isRunning }
                .map { snap ->
                    val index = snap.terminalId.removePrefix("term-").toIntOrNull() ?: 1
                    TerminalSessionItem(
                        terminalId = snap.terminalId,
                        displayLabel = if (index <= 1) "Terminal" else "Terminal $index",
                        status = snap.status,
                        cwd = snap.cwd,
                    )
                }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = backgroundColor),
                title = {
                    Column {
                        Text(
                            text = resolvedProfile.displayTarget.ifBlank { "Terminal" },
                            style = MaterialTheme.typography.titleSmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        val sub = activeSnapshot.cwd.ifBlank { resolvedProfile.connectionString }
                        if (sub.isNotBlank()) {
                            Text(
                                text = sub,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(
                            painter = painterResource(LucideR.drawable.lucide_ic_arrow_left),
                            contentDescription = "Back",
                            modifier = Modifier.size(20.dp),
                        )
                    }
                },
                actions = {
                    TerminalOptionsMenu(
                        statusLabel = statusLabel,
                        statusTone = statusTone,
                        errorDetail = errorDetail,
                        fontSize = fontSize,
                        sessions = sessionItems,
                        activeTerminalId = activeTerminalId,
                        isRunning = isRunning,
                        hasConnectionConfiguration = hasConnectionConfiguration,
                        canClear = activeSnapshot.bufferData.isNotEmpty(),
                        canResetKnownHost = resolvedProfile.host.isNotBlank(),
                        onSelectSession = { activeTerminalId = it },
                        onOpenNewTerminal = {
                            val nextIndex =
                                (
                                    sessionItems.maxOfOrNull {
                                        it.terminalId.removePrefix("term-").toIntOrNull() ?: 0
                                    } ?: 0
                                ) + 1
                            val nextId = "term-${nextIndex.coerceAtLeast(1)}"
                            actionError = null
                            activeTerminalId = nextId
                            userClosedIds = userClosedIds - nextId
                            openTerminalNow(nextId, resolvedProfile)
                        },
                        onToggleConnection = ::toggleConnection,
                        onOpenConnectionEditor = { showEditor = true },
                        onClear = { controller.clearBuffer(activeTerminalId) },
                        onResetKnownHost = {
                            actionError = null
                            controller.resetKnownHost(resolvedProfile.host, resolvedProfile.port)
                        },
                        onAdjustFontSize = { delta ->
                            fontSize = (fontSize + delta).coerceIn(TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX)
                        },
                    )
                },
            )
        },
        bottomBar = {
            if (hasConnectionConfiguration) {
                TerminalAccessoryBar(
                    actions = remember { accessoryButtonsFor(TerminalHostPlatform.Unknown) },
                    pendingModifier = pendingModifier,
                    theme = theme,
                    isEnabled = activeSnapshot.status == TerminalStatus.Running,
                    onAction = ::handleAccessoryAction,
                )
            }
        },
        containerColor = backgroundColor,
    ) { padding ->
        Box(
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .background(backgroundColor),
        ) {
            if (!hasConnectionConfiguration) {
                TerminalUnavailableView(theme, onOpenEditor = { showEditor = true })
            } else if (nativeAvailable) {
                TerminalWebViewSurface(
                    terminalKey = "$activeTerminalId:${activeSnapshot.instanceId.orEmpty()}",
                    initialBuffer = activeSnapshot.bufferData,
                    fontSize = fontSize,
                    theme = theme,
                    incomingOutput = incomingTerminalOutput,
                    isUnavailableSignal = { reason ->
                        nativeAvailable = false
                        actionError = reason
                    },
                    onInput = { bytes ->
                        if (activeSnapshot.status != TerminalStatus.Running) return@TerminalWebViewSurface
                        coroutineScope.launch {
                            runCatching { controller.writeInput(activeTerminalId, bytes) }
                        }
                    },
                    onResize = { cols, rows ->
                        coroutineScope.launch {
                            runCatching { controller.resize(activeTerminalId, cols, rows) }
                        }
                    },
                    modifier = Modifier.fillMaxSize().padding(8.dp),
                )
            } else {
                TermuxTerminalSurface(
                    output = incomingTerminalOutput,
                    onInput = { bytes ->
                        if (activeSnapshot.status != TerminalStatus.Running) return@TermuxTerminalSurface
                        coroutineScope.launch {
                            runCatching { controller.writeInput(activeTerminalId, bytes) }
                        }
                    },
                    onResize = { size ->
                        coroutineScope.launch {
                            runCatching { controller.resize(activeTerminalId, size.cols, size.rows) }
                        }
                    },
                    modifier = Modifier.fillMaxSize().padding(8.dp),
                )
            }
        }
    }

    if (showEditor) {
        TerminalConnectionEditorSheet(
            initialProfile = draftProfile,
            initialPrivateKey = draftPrivateKey,
            initialPassphrase = draftPassphrase,
            canSave = { profile, key ->
                profile.host.isNotBlank() && profile.username.isNotBlank() && controller.hasPrivateKey(key)
            },
            onDismiss = { showEditor = false },
            onResetKnownHost = { profile ->
                if (profile.host.isNotBlank()) {
                    controller.resetKnownHost(profile.host, profile.port)
                }
            },
            onSave = { profile, conn, key, passphrase ->
                draftProfile = profile
                connectionDraft = conn
                draftPrivateKey = key
                draftPassphrase = passphrase
                showEditor = false
                userClosedIds = userClosedIds - activeTerminalId
                bootstrappedIds = bootstrappedIds + activeTerminalId
                openTerminalNow(activeTerminalId, profile)
            },
        )
    }
}

@Composable
private fun TerminalUnavailableView(
    theme: TerminalTheme,
    onOpenEditor: () -> Unit,
) {
    Column(
        modifier =
            Modifier
                .fillMaxSize()
                .background(Color(android.graphics.Color.parseColor(theme.background)))
                .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "Terminal unavailable",
            style = MaterialTheme.typography.titleMedium,
            color = Color(android.graphics.Color.parseColor(theme.foreground)),
        )
        Text(
            text = "SSH connection and key are required before opening a shell.",
            style = MaterialTheme.typography.bodySmall,
            color = Color(android.graphics.Color.parseColor(theme.mutedForeground)),
            modifier = Modifier.padding(top = 8.dp),
        )
        Box(modifier = Modifier.padding(top = 12.dp)) {
            androidx.compose.material3.Button(onClick = onOpenEditor) {
                Text("SSH connection")
            }
        }
    }
}
