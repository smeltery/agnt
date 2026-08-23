// FILE: SettingsInfoCards.swift
// Purpose: Command reference, archived chats, and about settings cards.
// Layer: View

import SwiftUI
import UIKit

struct SettingsCommandReferenceCard: View {
    let commands = [
        SettingsCommandReference(
            command: "agnt up",
            detail: "Starts agnt on your computer, refreshes the bridge service, and prints a pairing QR for first-time setup or recovery."
        ),
        SettingsCommandReference(
            command: "agnt start",
            detail: "Starts the background bridge service without printing a QR in the current Terminal window."
        ),
        SettingsCommandReference(
            command: "agnt restart",
            detail: "Restarts the background bridge service when the computer is paired but the app cannot reconnect cleanly."
        ),
        SettingsCommandReference(
            command: "agnt qr / agnt pair",
            detail: "Refreshes the bridge and prints a new QR code so this iPhone can scan and trust the computer again."
        ),
        SettingsCommandReference(
            command: "agnt status",
            detail: "Shows whether the computer bridge service is loaded and whether a recent pairing payload is available."
        ),
        SettingsCommandReference(
            command: "agnt stop",
            detail: "Stops the background bridge service on your computer and clears its transient runtime status."
        ),
        SettingsCommandReference(
            command: "agnt reset-pairing",
            detail: "Clears saved pairing trust so the next connection requires a fresh QR scan."
        ),
        SettingsCommandReference(
            command: "agnt resume",
            detail: "Reopens the last active agnt thread in the active coding agent on your computer."
        ),
        SettingsCommandReference(
            command: "agnt watch [threadId]",
            detail: "Tails a thread event log in real time from Terminal."
        ),
        SettingsCommandReference(
            command: "agnt --version",
            detail: "Prints the installed agnt CLI version."
        )
    ]

    var body: some View {
        SettingsCard(title: "Computer commands") {
            Text("Run these in Terminal on your paired computer when you need to start, repair, or inspect the local agnt bridge.")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)

            ForEach(commands) { command in
                SettingsCommandReferenceRow(command: command)
            }
        }
    }
}

struct SettingsCommandReference: Identifiable {
    let command: String
    let detail: String

    var id: String { command }
}

struct SettingsCommandReferenceRow: View {
    let command: SettingsCommandReference

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(command.command)
                .font(AppFont.mono(.caption))
                .foregroundStyle(.primary)

            Text(command.detail)
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 2)
    }
}

struct SettingsArchivedChatsCard: View {
    @Environment(CodexService.self) private var codex

    var archivedCount: Int {
        codex.threads.filter { $0.syncState == .archivedLocal }.count
    }

    var body: some View {
        SettingsCard(title: "Archived Chats") {
            NavigationLink {
                ArchivedChatsView()
            } label: {
                HStack {
                    Label("Archived Chats", systemImage: "archivebox")
                        .font(AppFont.subheadline(weight: .medium))
                    Spacer()
                    if archivedCount > 0 {
                        Text("\(archivedCount)")
                            .font(AppFont.caption(weight: .medium))
                            .foregroundStyle(.secondary)
                    }
                    Image(systemName: "chevron.right")
                        .font(AppFont.caption(weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
        }
    }
}

struct SettingsAboutCard: View {
    var body: some View {
        SettingsCard(title: "About") {
            Text("Chats are End-to-end encrypted between your iPhone and your computer. The relay only sees ciphertext and connection metadata after the secure handshake completes.")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)

            // Keep About inside the Settings navigation stack so card refreshes
            // cannot dismiss a nested full-screen cover back to the app root.
            NavigationLink {
                AboutAgntView()
            } label: {
                settingsAccessoryRow(
                    title: "How agnt Works",
                    showsDisclosure: false,
                    leading: {
                        Image(systemName: "info.circle")
                            .font(AppFont.subheadline(weight: .medium))
                    }
                )
            }
            .buttonStyle(.plain)
            .simultaneousGesture(TapGesture().onEnded {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
            })

            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                if let url = URL(string: "https://github.com/smeltery/agnt") {
                    UIApplication.shared.open(url)
                }
            } label: {
                settingsAccessoryRow(
                    title: "Chat & Support",
                    leading: {
                        Image("github-mark-white")
                            .renderingMode(.template)
                            .resizable()
                            .scaledToFit()
                            .frame(width: 14, height: 14)
                    }
                )
            }
            .buttonStyle(.plain)

            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                UIApplication.shared.open(AppEnvironment.privacyPolicyURL)
            } label: {
                settingsAccessoryRow(
                    title: "Privacy Policy",
                    leading: {
                        Image(systemName: "hand.raised")
                            .font(AppFont.subheadline(weight: .medium))
                    }
                )
            }
            .buttonStyle(.plain)

            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                UIApplication.shared.open(AppEnvironment.termsOfUseURL)
            } label: {
                settingsAccessoryRow(
                    title: "Terms of Use",
                    leading: {
                        Image(systemName: "doc.text")
                            .font(AppFont.subheadline(weight: .medium))
                    }
                )
            }
            .buttonStyle(.plain)
        }
    }

    // Keeps settings rows visually consistent while allowing SF Symbols or asset icons.
    func settingsAccessoryRow<Leading: View>(
        title: String,
        showsDisclosure: Bool = true,
        @ViewBuilder leading: () -> Leading
    ) -> some View {
        HStack(spacing: 8) {
            leading()
            Text(title)
                .font(AppFont.subheadline(weight: .medium))
            Spacer()
            if showsDisclosure {
                Image(systemName: "chevron.right")
                    .font(AppFont.caption(weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .foregroundStyle(.primary)
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.primary.opacity(0.06))
        )
    }
}
