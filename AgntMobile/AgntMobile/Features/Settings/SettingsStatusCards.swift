// FILE: SettingsStatusCards.swift
// Purpose: Notification, ChatGPT voice, and bridge version settings cards.
// Layer: View

import SwiftUI
import UIKit

struct SettingsNotificationsCard: View {
    @Environment(CodexService.self) private var codex
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        SettingsCard(title: "Notifications") {
            HStack(spacing: 10) {
                Image(systemName: "bell.badge")
                    .foregroundStyle(.primary)
                Text("Status")
                Spacer()
                Text(statusLabel)
                    .foregroundStyle(.secondary)
            }

            Text("Used for local alerts when a run finishes while the app is in background.")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)

            if codex.notificationAuthorizationStatus == .notDetermined {
                SettingsButton("Allow notifications") {
                    HapticFeedback.shared.triggerImpactFeedback()
                    Task {
                        await codex.requestNotificationPermission()
                    }
                }
            }

            if codex.notificationAuthorizationStatus == .denied {
                SettingsButton("Open iOS Settings") {
                    HapticFeedback.shared.triggerImpactFeedback()
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
            }
        }
        .task {
            await codex.refreshManagedNotificationRegistrationState()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else {
                return
            }
            Task {
                await codex.refreshManagedNotificationRegistrationState()
            }
        }
    }

    var statusLabel: String {
        switch codex.notificationAuthorizationStatus {
        case .authorized: "Authorized"
        case .denied: "Denied"
        case .provisional: "Provisional"
        case .ephemeral: "Ephemeral"
        case .notDetermined: "Not requested"
        @unknown default: "Unknown"
        }
    }
}

struct SettingsGPTAccountCard: View {
    @State private var isShowingMacLoginInfo = false

    var body: some View {
        SettingsCard(title: "ChatGPT voice mode") {
            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                isShowingMacLoginInfo = true
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "info.circle")
                        .font(AppFont.subheadline(weight: .medium))
                    Text("Info")
                        .font(AppFont.subheadline(weight: .medium))
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(AppFont.caption(weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
                .foregroundStyle(.primary)
                .padding(.vertical, 10)
                .padding(.horizontal, 14)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.primary.opacity(0.06))
                )
            }
            .buttonStyle(.plain)
        }
        .sheet(isPresented: $isShowingMacLoginInfo) {
            GPTVoiceSetupSheet()
        }
    }
}

struct SettingsBridgeVersionCard: View {
    @Environment(CodexService.self) private var codex
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        SettingsCard(title: "Bridge Version") {
            HStack(spacing: 10) {
                Text("Status")
                Spacer()
                SettingsStatusPill(label: versionStatusLabel)
            }

            settingsVersionRow(
                title: "Installed on Computer",
                value: installedVersionLabel,
                valueStyle: installedValueStyle
            )

            settingsVersionRow(
                title: "Latest available",
                value: latestVersionLabel,
                valueStyle: .primary
            )

            if let guidance = guidanceText {
                Text(guidance)
                    .font(AppFont.caption())
                    .foregroundStyle(guidanceColor)
            }
        }
        .task {
            await codex.refreshBridgeVersionState()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task {
                await codex.refreshBridgeVersionState()
            }
        }
    }

    var installedVersionLabel: String {
        normalizedVersion(codex.bridgeInstalledVersion) ?? "Unknown"
    }

    var latestVersionLabel: String {
        normalizedVersion(codex.latestBridgePackageVersion) ?? "Unknown"
    }

    var guidanceText: String? {
        guard let installedVersion else {
            return "Connect to a computer bridge to read the installed package version."
        }

        guard let latestVersion else {
            return "Installed version detected. The latest published package is unavailable right now."
        }

        if installedVersion == latestVersion {
            return "The installed bridge matches the latest published package."
        }

        if installedVersion.compare(latestVersion, options: .numeric) == .orderedAscending {
            return "A newer agnt package is available on npm."
        }

        return "The paired computer is running a different build than the current npm latest."
    }

    var versionStatusLabel: String {
        guard let installedVersion else {
            return "Unknown"
        }

        guard let latestVersion else {
            return "Installed"
        }

        if installedVersion == latestVersion {
            return "Up to date"
        }

        if installedVersion.compare(latestVersion, options: .numeric) == .orderedAscending {
            return "Update available"
        }

        return "Different build"
    }

    var guidanceColor: Color {
        guard let installedVersion,
              let latestVersion,
              installedVersion.compare(latestVersion, options: .numeric) == .orderedAscending else {
            return .secondary
        }

        return .orange
    }

    var installedValueStyle: Color {
        guard let installedVersion,
              let latestVersion,
              installedVersion.compare(latestVersion, options: .numeric) == .orderedAscending else {
            return .primary
        }

        return .orange
    }

    var installedVersion: String? {
        normalizedVersion(codex.bridgeInstalledVersion)
    }

    var latestVersion: String? {
        normalizedVersion(codex.latestBridgePackageVersion)
    }

    func normalizedVersion(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }

        return trimmed
    }

    func settingsVersionRow(title: String, value: String, valueStyle: Color) -> some View {
        HStack(spacing: 12) {
            Text(title)
            Spacer()
            Text(value)
                .font(AppFont.mono(.subheadline))
                .foregroundStyle(valueStyle)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
        }
    }
}
