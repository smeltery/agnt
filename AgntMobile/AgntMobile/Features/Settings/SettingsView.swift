// FILE: SettingsView.swift
// Purpose: Settings for Local Mode (Codex runs on the paired computer, relay WebSocket).
// Layer: View
// Exports: SettingsView

import SwiftUI
import UIKit

struct SettingsComputerNamePresentation: Identifiable {
    let deviceId: String?
    let currentName: String
    let systemName: String

    var id: String { deviceId ?? currentName }
}

struct SettingsView: View {
    @Environment(CodexService.self) private var codex

    @AppStorage("codex.appFontStyle") private var appFontStyleRawValue = AppFont.defaultStoredStyleRawValue
    @State private var computerNamePresentation: SettingsComputerNamePresentation?

    private let runtimeAutoValue = "__AUTO__"
    private let runtimeNormalValue = "__NORMAL__"
    private let settingsAccentColor = Color(.plan)

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                SettingsArchivedChatsCard()
                SettingsAppearanceCard(appFontStyle: appFontStyleBinding)
                SettingsNotificationsCard()
                SettingsGPTAccountCard()
                SettingsBridgeVersionCard()
                SettingsCommandReferenceCard()
                runtimeDefaultsSection
                SettingsAboutCard()
                SettingsUsageCard()
                connectionSection
            }
            .padding()
        }
        .font(AppFont.body())
        .navigationTitle("Settings")
        // Own settings modals from the stable screen root; nested cards can be
        // rebuilt while connection status changes and should not own sheets.
        .sheet(item: $computerNamePresentation) { presentation in
            SettingsComputerNameSheet(
                nickname: sidebarComputerNicknameBinding(for: presentation.deviceId),
                currentName: presentation.currentName,
                systemName: presentation.systemName
            )
        }
    }

    private var appFontStyleBinding: Binding<AppFont.Style> {
        Binding(
            get: { AppFont.Style(rawValue: appFontStyleRawValue) ?? AppFont.defaultStyle },
            set: { appFontStyleRawValue = $0.rawValue }
        )
    }

    private var keepMacAwakeWhileBridgeRunsBinding: Binding<Bool> {
        Binding(
            get: { codex.keepMacAwakeWhileBridgeRuns },
            set: { nextValue in
                codex.setKeepMacAwakeWhileBridgeRunsPreference(nextValue)
                Task { @MainActor in
                    await codex.syncBridgeKeepMacAwakePreferenceIfNeeded(showFailureInUI: true)
                }
            }
        )
    }

    private var enableWebTerminalOnBridgeBinding: Binding<Bool> {
        Binding(
            get: { codex.enableWebTerminalOnBridge },
            set: { nextValue in
                codex.setEnableWebTerminalOnBridgePreference(nextValue)
                Task { @MainActor in
                    await codex.syncBridgeEnableWebTerminalPreferenceIfNeeded(showFailureInUI: true)
                }
            }
        )
    }

    // MARK: - Runtime defaults

    @ViewBuilder private var runtimeDefaultsSection: some View {
        SettingsCard(title: "Runtime defaults") {
            HStack {
                Text("Model")
                Spacer()
                Picker("Model", selection: runtimeModelSelection) {
                    Text("Auto").tag(runtimeAutoValue)
                    ForEach(runtimeModelOptions, id: \.id) { model in
                        Text(TurnComposerMetaMapper.modelTitle(for: model))
                            .tag(model.id)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .tint(settingsAccentColor)
            }

            HStack {
                Text("Reasoning")
                Spacer()
                Picker("Reasoning", selection: runtimeReasoningSelection) {
                    Text("Auto").tag(runtimeAutoValue)
                    ForEach(runtimeReasoningOptions, id: \.id) { option in
                        Text(option.title).tag(option.effort)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .tint(settingsAccentColor)
                .disabled(runtimeReasoningOptions.isEmpty)
            }

            if codex.selectedModelSupportsServiceTier(.fast) {
                HStack {
                    Text("Speed")
                    Spacer()
                    Picker("Speed", selection: runtimeServiceTierSelection) {
                        Text("Normal").tag(runtimeNormalValue)
                        ForEach(CodexServiceTier.allCases, id: \.rawValue) { tier in
                            Text(tier.displayName).tag(tier.rawValue)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .tint(settingsAccentColor)
                }
            }

            HStack {
                Text("Access")
                Spacer()
                Picker("Access", selection: runtimeAccessSelection) {
                    ForEach(CodexAccessMode.allCases, id: \.self) { mode in
                        Text(mode.displayName).tag(mode)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .tint(settingsAccentColor)
            }

            Divider()

            HStack {
                Text("Git writer model")
                Spacer()
                Picker("Git writer model", selection: gitWriterModelSelection) {
                    ForEach(gitWriterModelOptions, id: \.id) { model in
                        Text(TurnComposerMetaMapper.modelTitle(for: model))
                            .tag(model.id)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .tint(settingsAccentColor)
                .disabled(gitWriterModelOptions.isEmpty)
            }

            Text("Used for AI-generated commit messages and PR drafts. Defaults to GPT-5.4 Mini when available.")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Connection

    @ViewBuilder private var connectionSection: some View {
        SettingsCard(title: "Connection") {
            if let trustedPairPresentation = codex.trustedPairPresentation {
                SettingsTrustedComputerCard(
                    presentation: trustedPairPresentation,
                    connectionStatusLabel: connectionStatusLabel,
                    onEditName: {
                        presentComputerNameSheet()
                    }
                )
            } else {
                Text("No paired computer")
                    .font(AppFont.subheadline(weight: .semibold))
                    .foregroundStyle(.primary)
            }

            if connectionPhaseShowsProgress {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(connectionProgressLabel)
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                }
            }

            if case .retrying(_, let message) = codex.connectionRecoveryState,
               !message.isEmpty {
                Text(message)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }

            if let error = codex.lastErrorMessage, !error.isEmpty {
                Text(error)
                    .font(AppFont.caption())
                    .foregroundStyle(.red)
            }

            Divider()

            if codex.supportsKeepAwakeWhileBridgeRuns {
                Toggle("Keep computer reachable", isOn: keepMacAwakeWhileBridgeRunsBinding)
                    .tint(settingsAccentColor)

                Text(codex.keepMacAwakeWhileBridgeRuns
                     ? "Uses the host computer's keep-awake support while the bridge is running so the computer stays reachable even if the display turns off. Best while charging."
                     : "The computer can go back to sleeping normally when the bridge is idle.")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)

                if !codex.isConnected {
                    Text("Saved on this iPhone. It will sync to the paired computer the next time the bridge reconnects.")
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                }
            }

            Divider()

            // Browser-only feature: when on, the agnt-web client gets a
            // Terminal button that opens a shell on the bridge host. iOS keeps
            // its own on-device SSH terminal regardless of this toggle.
            Toggle("Allow web terminal sessions", isOn: enableWebTerminalOnBridgeBinding)
                .tint(settingsAccentColor)
            Text(codex.enableWebTerminalOnBridge
                 ? "Browser clients paired with this bridge can spawn a shell on the bridge host. Anyone with access to a paired browser session gets the same shell access as the user that started agnt up."
                 : "Browser clients paired with this bridge cannot spawn a shell on the bridge host.")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
            if !codex.isConnected {
                Text("Saved on this iPhone. It will sync to the paired computer the next time the bridge reconnects.")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }

            if codex.isConnected {
                SettingsButton("Disconnect", role: .destructive) {
                    HapticFeedback.shared.triggerImpactFeedback()
                    disconnectRelay()
                }
            } else if codex.hasTrustedMacReconnectCandidate {
                SettingsButton("Forget Pair", role: .destructive) {
                    HapticFeedback.shared.triggerImpactFeedback()
                    codex.forgetTrustedMac()
                }
            }
        }
    }

    private var connectionPhaseShowsProgress: Bool {
        switch codex.connectionPhase {
        case .connecting, .loadingChats, .syncing:
            return true
        case .offline, .connected:
            return false
        }
    }

    private var connectionStatusLabel: String {
        switch codex.connectionPhase {
        case .offline:
            return "offline"
        case .connecting:
            return "connecting"
        case .loadingChats:
            return "loading chats"
        case .syncing:
            return "syncing"
        case .connected:
            return "connected"
        }
    }

    private var connectionProgressLabel: String {
        switch codex.connectionPhase {
        case .connecting:
            return "Connecting to relay..."
        case .loadingChats:
            return "Loading chats..."
        case .syncing:
            return "Syncing workspace..."
        case .offline, .connected:
            return ""
        }
    }

    // MARK: - Actions

    private func disconnectRelay() {
        Task { @MainActor in
            await codex.disconnect()
            codex.clearSavedRelaySession()
        }
    }

    // MARK: - Runtime bindings

    private var runtimeModelOptions: [CodexModelOption] {
        TurnComposerMetaMapper.orderedModels(from: codex.availableModels)
    }

    private var runtimeReasoningOptions: [TurnComposerReasoningDisplayOption] {
        TurnComposerMetaMapper.reasoningDisplayOptions(
            from: codex.supportedReasoningEffortsForSelectedModel().map(\.reasoningEffort)
        )
    }

    private var runtimeModelSelection: Binding<String> {
        Binding(
            get: { codex.selectedModelOption()?.id ?? runtimeAutoValue },
            set: { selection in
                codex.setSelectedModelId(selection == runtimeAutoValue ? nil : selection)
            }
        )
    }

    private var runtimeReasoningSelection: Binding<String> {
        Binding(
            get: { codex.selectedReasoningEffort ?? runtimeAutoValue },
            set: { selection in
                codex.setSelectedReasoningEffort(selection == runtimeAutoValue ? nil : selection)
            }
        )
    }

    private var runtimeAccessSelection: Binding<CodexAccessMode> {
        Binding(
            get: { codex.selectedAccessMode },
            set: { codex.setSelectedAccessMode($0) }
        )
    }

    private var runtimeServiceTierSelection: Binding<String> {
        Binding(
            get: { codex.selectedServiceTier?.rawValue ?? runtimeNormalValue },
            set: { selection in
                codex.setSelectedServiceTier(
                    selection == runtimeNormalValue ? nil : CodexServiceTier(rawValue: selection)
                )
            }
        )
    }

    private var gitWriterModelOptions: [CodexModelOption] {
        TurnComposerMetaMapper.orderedModels(from: codex.availableModels)
    }

    private var gitWriterModelSelection: Binding<String> {
        Binding(
            get: { codex.selectedGitWriterModelOption()?.id ?? gitWriterModelOptions.first?.id ?? "" },
            set: { codex.setSelectedGitWriterModelId($0.isEmpty ? nil : $0) }
        )
    }

    // Captures the visible device details before presenting so reconnect updates cannot dismiss the editor.
    private func presentComputerNameSheet() {
        guard let trustedPairPresentation = codex.trustedPairPresentation else {
            return
        }

        computerNamePresentation = SettingsComputerNamePresentation(
            deviceId: trustedPairPresentation.deviceId,
            currentName: trustedPairPresentation.name,
            systemName: trustedPairPresentation.systemName ?? trustedPairPresentation.name
        )
    }

    // Writes nicknames against the tapped trusted computer so switching pairs does not reuse the wrong alias.
    private func sidebarComputerNicknameBinding(for deviceId: String?) -> Binding<String> {
        Binding(
            get: { SidebarComputerNicknameStore.nickname(for: deviceId) },
            set: { SidebarComputerNicknameStore.setNickname($0, for: deviceId) }
        )
    }
}

// MARK: - Reusable card / button components
