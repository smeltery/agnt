// FILE: TerminalScreen.swift
// Purpose: Full-page Ghostty SSH terminal route modeled after t3code-mobile's terminal screen.
// Layer: View
// Exports: TerminalScreen
// Depends on: CodexService, GhosttyTerminalSurface, AgntTerminalModels

import Foundation
import SwiftUI
import UIKit

struct TerminalScreen: View {
    @Environment(CodexService.self) private var codex
    @Environment(\.colorScheme) private var colorScheme
    @State private var draftProfile = AgntTerminalProfileStore.load()
    @State private var connectionDraft = AgntTerminalProfileStore.load().connectionString
    @State private var privateKeyDraft = AgntTerminalPrivateKeyStore.loadPrivateKey()
    @State private var passphraseDraft = AgntTerminalPrivateKeyStore.loadPassphrase()
    @State private var isShowingConnectionEditor = false
    @State private var activeTerminalId = CodexService.defaultTerminalId
    @State private var bootstrappedTerminalIds = Set<String>()
    @State private var userClosedTerminalIds = Set<String>()
    @State private var isNativeTerminalAvailable = true
    @State private var actionErrorMessage: String?
    @State private var didApplyPreferredWorkingDirectory = false
    @State private var pendingModifier: TerminalPendingModifier?
    @State private var terminalTextReader = GhosttyTerminalTextReader()
    @State private var selectableTextState: TerminalSelectableTextState?
    @AppStorage("codex.terminal.fontSize") private var terminalFontSize = agntTerminalDefaultFontSize

    let preferredWorkingDirectory: String?

    private var theme: AgntTerminalTheme {
        AgntTerminalTheme.resolved(for: colorScheme)
    }

    private var hostPlatform: TerminalHostPlatform {
        TerminalHostPlatform.infer(
            from: [
                codex.trustedPairPresentation?.systemName,
                codex.trustedPairPresentation?.name,
                draftProfile.displayTarget,
            ]
            .compactMap { $0 }
            .joined(separator: " ")
        )
    }

    private var profileResolvedFromConnection: AgntTerminalProfile {
        var profile = draftProfile
        profile.applyConnectionString(connectionDraft)
        return profile.normalizedForSave
    }

    private var hasConnectionConfiguration: Bool {
        let profile = profileResolvedFromConnection
        return !profile.host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !profile.username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && AgntTerminalPrivateKeyStore.hasPrivateKey(privateKeyDraft)
    }

    private var isRunning: Bool {
        activeSnapshot.status == .running || activeSnapshot.status == .starting
    }

    private var terminalKey: String {
        "\(activeTerminalId):\(activeSnapshot.instanceId ?? "idle")"
    }

    private var activeSnapshot: AgntTerminalSnapshot {
        codex.terminalSnapshot(for: activeTerminalId)
    }

    private var currentWorkingDirectory: String {
        terminalFirstNonEmpty([
            activeSnapshot.cwd,
            profileResolvedFromConnection.cwd,
            preferredWorkingDirectory,
        ]) ?? ""
    }

    private var terminalHostTitle: String {
        terminalFirstNonEmpty([
            profileResolvedFromConnection.nickname,
            codex.trustedPairPresentation?.name,
            profileResolvedFromConnection.displayTarget,
        ]) ?? "Terminal"
    }

    private var navigationTopLine: String {
        let topLine = [
            terminalHostTitle,
            terminalProjectDisplayName(for: currentWorkingDirectory),
        ]
        .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
        .joined(separator: " · ")

        return topLine.isEmpty ? "Terminal" : topLine
    }

    private var navigationBottomLine: String {
        terminalFirstNonEmpty([
            currentWorkingDirectory,
            profileResolvedFromConnection.connectionString,
            "SSH terminal",
        ]) ?? "SSH terminal"
    }

    private var statusLabel: String {
        terminalStatusLabel(for: activeSnapshot.status)
    }

    private var terminalErrorDetail: String? {
        let value = actionErrorMessage ?? activeSnapshot.errorMessage
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private var statusTone: TerminalStatusTone {
        terminalStatusTone(for: activeSnapshot.status)
    }

    private var terminalToolbarActions: [TerminalToolbarAction] {
        buildTerminalToolbarActions(for: hostPlatform)
    }

    private var terminalMenuSessions: [TerminalMenuSessionItem] {
        var snapshots = codex.knownTerminalSnapshots()
        if !snapshots.contains(where: { $0.terminalId == activeTerminalId }) {
            snapshots.append(activeSnapshot)
        }
        return buildTerminalMenuSessions(from: snapshots, activeTerminalId: activeTerminalId)
    }

    private var canPasteIntoActiveTerminal: Bool {
        activeSnapshot.status == .running && UIPasteboard.general.hasStrings
    }

    private var canSelectTerminalText: Bool {
        isNativeTerminalAvailable && !activeSnapshot.bufferData.isEmpty
    }

    var body: some View {
        ZStack {
            Color(hexString: theme.background)
                .ignoresSafeArea()

            terminalRouteBody
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color(hexString: theme.background), for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(colorScheme, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                TerminalRouteTitle(
                    topLine: navigationTopLine,
                    bottomLine: navigationBottomLine,
                    theme: theme
                )
            }
            ToolbarItem(placement: .topBarTrailing) {
                TerminalOptionsMenu(
                    statusLabel: statusLabel,
                    errorDetail: terminalErrorDetail,
                    statusTone: statusTone,
                    fontSize: terminalFontSize,
                    sessions: terminalMenuSessions,
                    activeTerminalId: activeTerminalId,
                    isRunning: isRunning,
                    hasConnectionConfiguration: hasConnectionConfiguration,
                    canPaste: canPasteIntoActiveTerminal,
                    canSelectText: canSelectTerminalText,
                    canClear: !activeSnapshot.bufferData.isEmpty,
                    canResetKnownHost: !profileResolvedFromConnection.host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                    onSelectSession: selectTerminalSession,
                    onOpenNewTerminal: openNewTerminalFromMenu,
                    onToggleConnection: toggleTerminalConnection,
                    onOpenConnectionEditor: showConnectionEditor,
                    onPaste: pasteIntoActiveTerminal,
                    onSelectText: presentSelectableTerminalText,
                    onClear: clearTerminal,
                    onResetKnownHost: resetKnownHost,
                    onAdjustFontSize: adjustFontSize
                )
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if hasConnectionConfiguration {
                TerminalRouteAccessoryBar(
                    actions: terminalToolbarActions,
                    pendingModifier: pendingModifier,
                    theme: theme,
                    isEnabled: activeSnapshot.status == .running,
                    onAction: handleToolbarActionPress
                )
            }
        }
        .sheet(item: $selectableTextState) { state in
            TerminalSelectableTextSheet(
                state: state,
                fontSize: CGFloat(terminalFontSize),
                theme: theme
            )
        }
        .sheet(isPresented: $isShowingConnectionEditor) {
            TerminalConnectionEditorSheet(
                profile: $draftProfile,
                connection: $connectionDraft,
                privateKey: $privateKeyDraft,
                passphrase: $passphraseDraft,
                canSave: hasConnectionConfiguration,
                onSave: {
                    Task { @MainActor in
                        await saveConnectionAndOpen()
                    }
                },
                onResetKnownHost: resetKnownHost
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .task(id: activeTerminalId) {
            await bootstrapTerminalRoute()
        }
        .onChange(of: preferredWorkingDirectory) { _, _ in
            didApplyPreferredWorkingDirectory = false
            applyPreferredWorkingDirectoryIfNeeded()
        }
    }

    @ViewBuilder
    private var terminalRouteBody: some View {
        TerminalRouteSurface(
            hasConnectionConfiguration: hasConnectionConfiguration,
            isNativeTerminalAvailable: isNativeTerminalAvailable,
            terminalKey: terminalKey,
            snapshot: activeSnapshot,
            fontSize: CGFloat(terminalFontSize),
            colorScheme: colorScheme,
            theme: theme,
            isRunning: isRunning,
            textReader: terminalTextReader,
            onShowConnectionEditor: showConnectionEditor,
            onDataInput: handleTerminalDataInput,
            onTextInput: handleTerminalTextInput,
            onResize: resizeTerminal,
            onNativeAvailabilityChanged: { isNativeTerminalAvailable = $0 }
        )
    }

    private func bootstrapTerminalRoute() async {
        if restoreRunningTerminalIfNeeded() {
            return
        }
        applyPreferredWorkingDirectoryIfNeeded()
        connectionDraft = draftProfile.connectionString
        try? await codex.refreshTerminalSnapshot()

        guard hasConnectionConfiguration else {
            isShowingConnectionEditor = true
            return
        }
        guard !bootstrappedTerminalIds.contains(activeTerminalId),
              !userClosedTerminalIds.contains(activeTerminalId) else { return }
        guard !isRunning else {
            bootstrappedTerminalIds.insert(activeTerminalId)
            return
        }

        bootstrappedTerminalIds.insert(activeTerminalId)
        await openTerminal()
    }

    private func restoreRunningTerminalIfNeeded() -> Bool {
        guard activeTerminalId == CodexService.defaultTerminalId else { return false }
        let runningSnapshots = codex.knownTerminalSnapshots().filter { $0.status.isRunning }
        guard let preferredSnapshot = runningSnapshots.first(where: { $0.terminalId == CodexService.defaultTerminalId })
            ?? runningSnapshots.first else {
            return false
        }
        guard preferredSnapshot.terminalId != activeTerminalId else {
            return false
        }
        activeTerminalId = preferredSnapshot.terminalId
        return true
    }

    private func selectTerminalSession(_ terminalId: String) {
        activeTerminalId = terminalId
    }

    private func openNewTerminalFromMenu() {
        Task { @MainActor in
            await openNewTerminal()
        }
    }

    private func toggleTerminalConnection() {
        Task { @MainActor in
            if isRunning {
                await closeTerminal()
            } else {
                userClosedTerminalIds.remove(activeTerminalId)
                await openTerminal()
            }
        }
    }

    private func showConnectionEditor() {
        isShowingConnectionEditor = true
    }

    private func presentSelectableTerminalText() {
        guard let text = terminalTextReader.visibleText() ?? fallbackSelectableTerminalText else { return }
        selectableTextState = TerminalSelectableTextState(text: text)
    }

    private var fallbackSelectableTerminalText: String? {
        let rawText = String(decoding: activeSnapshot.bufferData, as: UTF8.self)
        return TerminalSelectableTextNormalizer.normalizedText(from: rawText)
    }

    private func saveConnectionAndOpen() async {
        isShowingConnectionEditor = false
        userClosedTerminalIds.remove(activeTerminalId)
        bootstrappedTerminalIds.insert(activeTerminalId)
        await openTerminal()
    }

    private func openNewTerminal() async {
        let nextTerminalId = nextOpenTerminalId()
        draftProfile.applyPreferredWorkingDirectoryOverride(currentWorkingDirectory)
        activeTerminalId = nextTerminalId
        userClosedTerminalIds.remove(nextTerminalId)
        bootstrappedTerminalIds.insert(nextTerminalId)
        actionErrorMessage = nil
        await openTerminal()
    }

    private func openTerminal() async {
        draftProfile = profileResolvedFromConnection
        let selectedCWD = activeSnapshot.cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        if !selectedCWD.isEmpty {
            draftProfile.cwd = selectedCWD
        }
        guard hasConnectionConfiguration else {
            isShowingConnectionEditor = true
            return
        }

        actionErrorMessage = nil
        AgntTerminalProfileStore.save(draftProfile)
        AgntTerminalPrivateKeyStore.savePrivateKey(privateKeyDraft)
        AgntTerminalPrivateKeyStore.savePassphrase(passphraseDraft)

        do {
            try await codex.openTerminal(
                terminalId: activeTerminalId,
                profile: draftProfile,
                cols: activeSnapshot.cols,
                rows: activeSnapshot.rows
            )
        } catch {
            actionErrorMessage = terminalErrorText(from: error)
        }
    }

    private func closeTerminal() async {
        userClosedTerminalIds.insert(activeTerminalId)
        actionErrorMessage = nil
        do {
            try await codex.closeTerminal(terminalId: activeTerminalId)
        } catch {
            actionErrorMessage = terminalErrorText(from: error)
        }
    }

    private func resetKnownHost() {
        let profile = profileResolvedFromConnection.normalizedForSave
        guard !profile.host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        AgntSSHKnownHostStore.delete(host: profile.host, port: profile.port)
        actionErrorMessage = nil
    }

    private func clearTerminal() {
        actionErrorMessage = nil
        Task { @MainActor in
            do {
                try await codex.clearTerminalBuffer(terminalId: activeTerminalId)
            } catch {
                actionErrorMessage = terminalErrorText(from: error)
            }
        }
    }

    private func pasteIntoActiveTerminal() {
        guard activeSnapshot.status == .running,
              let pasteText = UIPasteboard.general.string,
              !pasteText.isEmpty else { return }

        pendingModifier = nil
        writeInputChunks(Self.terminalPasteInputChunks(
            for: pasteText,
            bracketedPasteEnabled: activeSnapshot.bracketedPasteEnabled
        ))
    }

    private func applyPreferredWorkingDirectoryIfNeeded() {
        guard !didApplyPreferredWorkingDirectory else { return }
        didApplyPreferredWorkingDirectory = true
        draftProfile.applyPreferredWorkingDirectoryOverride(preferredWorkingDirectory)
        let trimmedCWD = draftProfile.cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedCWD.isEmpty,
              activeSnapshot.status == .running,
              activeSnapshot.cwd != trimmedCWD else {
            return
        }
        Task { @MainActor in
            do {
                try await codex.changeTerminalWorkingDirectory(trimmedCWD, terminalId: activeTerminalId)
            } catch {
                actionErrorMessage = terminalErrorText(from: error)
            }
        }
    }

    private func handleTerminalDataInput(_ data: Data) {
        guard !data.isEmpty else { return }
        guard let text = String(data: data, encoding: .utf8) else {
            writeInput(data)
            return
        }
        handleTerminalTextInput(text)
    }

    private func handleTerminalTextInput(_ text: String) {
        guard !text.isEmpty else { return }

        let outputText: String
        switch pendingModifier {
        case .ctrl:
            pendingModifier = nil
            outputText = Self.applyCtrlModifier(text)
        case .meta:
            pendingModifier = nil
            outputText = "\u{1B}\(text)"
        case nil:
            outputText = text
        }

        writeInput(Data(outputText.utf8))
    }

    private func handleToolbarActionPress(_ action: TerminalToolbarAction) {
        switch action.kind {
        case .modifier(let modifier):
            pendingModifier = pendingModifier == modifier ? nil : modifier
        case .send(let data):
            handleTerminalTextInput(data)
        }
    }

    private func writeInput(_ data: Data) {
        guard activeSnapshot.status == .running else { return }
        let terminalId = activeTerminalId
        Task { @MainActor in
            try? await codex.writeTerminalInput(data, terminalId: terminalId)
        }
    }

    private func writeInputChunks(_ chunks: [Data]) {
        guard activeSnapshot.status == .running, !chunks.isEmpty else { return }
        let terminalId = activeTerminalId
        Task { @MainActor in
            for chunk in chunks where !chunk.isEmpty {
                try? await codex.writeTerminalInput(chunk, terminalId: terminalId)
            }
        }
    }

    private func resizeTerminal(cols: Int, rows: Int) {
        Task { @MainActor in
            try? await codex.resizeTerminal(terminalId: activeTerminalId, cols: cols, rows: rows)
        }
    }

    private func adjustFontSize(_ delta: Double) {
        terminalFontSize = min(
            agntTerminalMaxFontSize,
            max(agntTerminalMinFontSize, terminalFontSize + delta)
        )
    }

    private func nextOpenTerminalId() -> String {
        terminalNextOpenTerminalId(from: terminalMenuSessions.map(\.terminalId))
    }
}
