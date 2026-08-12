// FILE: SettingsAppearanceUsageCards.swift
// Purpose: Appearance, companion pet, and usage settings cards.
// Layer: View

import SwiftUI
import UIKit

struct SettingsUsageCard: View {
    @Environment(CodexService.self) private var codex
    @Environment(\.scenePhase) private var scenePhase

    @State private var isRefreshing = false

    var body: some View {
        SettingsCard(title: "Usage") {
            UsageStatusSummaryContent(
                contextWindowUsage: nil,
                showsContextWindowSection: false,
                rateLimitBuckets: codex.rateLimitBuckets,
                isLoadingRateLimits: codex.isLoadingRateLimits,
                rateLimitsErrorMessage: codex.rateLimitsErrorMessage,
                refreshControl: UsageStatusRefreshControl(
                    title: "Refresh",
                    isRefreshing: isRefreshing,
                    action: refreshStatus
                )
            )
        }
        .task {
            await refreshStatusIfNeeded()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task {
                await refreshStatusIfNeeded()
            }
        }
    }

    func refreshStatus() {
        guard !isRefreshing else { return }
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        isRefreshing = true

        Task {
            await refreshStatusData()
            await MainActor.run {
                isRefreshing = false
            }
        }
    }

    func refreshStatusIfNeeded() async {
        guard !isRefreshing else { return }
        guard codex.shouldAutoRefreshUsageStatus(threadId: nil) else { return }

        await MainActor.run {
            isRefreshing = true
        }
        await refreshStatusData()
        await MainActor.run {
            isRefreshing = false
        }
    }

    // Settings only needs the account-wide usage windows.
    func refreshStatusData() async {
        await codex.refreshUsageStatus(threadId: nil)
    }
}

struct SettingsAppearanceCard: View {
    @Binding var appFontStyle: AppFont.Style
    @AppStorage("codex.useLiquidGlass") private var useLiquidGlass = true
    @AppStorage(UserBubbleColor.storageKey) private var userBubbleColorRawValue = UserBubbleColor.defaultStoredRawValue
    let settingsAccentColor = Color(.plan)

    var body: some View {
        SettingsCard(title: "Appearance") {
            SettingsMenuPickerRow(
                title: "Font",
                value: appFontStyle.title,
                options: AppFont.Style.allCases.map { style in
                    SettingsMenuPickerOption(value: style, title: style.title)
                },
                selection: $appFontStyle
            )

            Text(appFontStyle.subtitle)
                .font(AppFont.caption())
                .foregroundStyle(.secondary)

            HStack {
                Text("Message Bubble")
                Spacer()
                UIKitMenuButton {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(selectedUserBubbleColor.swatchColor)
                            .frame(width: 14, height: 14)
                        Text(selectedUserBubbleColor.title)
                            .font(AppFont.callout())
                    }
                    .foregroundStyle(.primary)
                    .contentShape(Rectangle())
                } menu: {
                    UIMenu(
                        options: [.singleSelection],
                        children: UserBubbleColor.allCases.map { color in
                            UIAction(
                                title: color.title,
                                image: color.menuSwatchImage,
                                state: color == selectedUserBubbleColor ? .on : .off
                            ) { _ in
                                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                                userBubbleColorRawValue = color.rawValue
                            }
                        }
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Message bubble color")
                .accessibilityValue(selectedUserBubbleColor.title)
            }

            if GlassPreference.isSupported {
                Divider()

                Toggle("Liquid Glass", isOn: $useLiquidGlass)
                    .tint(settingsAccentColor)

                Text(useLiquidGlass
                     ? "Liquid Glass effects are enabled."
                     : "Using solid material fallback.")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }

            Divider()

            SettingsPetCompanionSection(settingsAccentColor: settingsAccentColor)
        }
    }

    private var selectedUserBubbleColor: UserBubbleColor {
        UserBubbleColor(rawValue: userBubbleColorRawValue) ?? .default
    }
}

struct SettingsPetCompanionSection: View {
    @Environment(CodexService.self) private var codex
    @Environment(PetCompanionStore.self) private var petStore

    let settingsAccentColor: Color

    var body: some View {
        Group {
            HStack {
                Toggle("Companion Pet", isOn: petEnabledBinding)
                    .tint(settingsAccentColor)

                Text("BETA")
                    .font(AppFont.caption2(weight: .bold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .fill(Color(.tertiarySystemFill))
                    )
            }

            if petStore.isEnabled {
                if petStore.availablePets.isEmpty {
                    Text(petStore.isLoading
                         ? "Loading local Codex pets from your Mac..."
                         : "No local Codex pets found in ~/.codex/pets.")
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                } else {
                    SettingsMenuPickerRow(
                        title: "Pet",
                        value: petStore.selectedPet?.displayName ?? "None",
                        options: petStore.availablePets.map { pet in
                            SettingsMenuPickerOption(value: pet.id, title: pet.displayName)
                        },
                        selection: selectedPetBinding
                    )

                    if let description = petStore.selectedPet?.description,
                       !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(description)
                            .font(AppFont.caption())
                            .foregroundStyle(.secondary)
                    }
                }

                if let errorMessage = petStore.errorMessage {
                    Text(errorMessage)
                        .font(AppFont.caption())
                        .foregroundStyle(.red)
                }

                SettingsButton("Refresh Pets", isLoading: petStore.isLoading) {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    Task {
                        await petStore.refreshPets(codex: codex)
                    }
                }
            }
        }
        .task(id: codex.isConnected) {
            guard codex.isConnected, petStore.isEnabled else {
                return
            }
            await petStore.loadPetsIfNeeded(codex: codex)
            await petStore.loadSelectedPet(codex: codex)
        }
    }

    var petEnabledBinding: Binding<Bool> {
        Binding(
            get: { petStore.isEnabled },
            set: { isEnabled in
                petStore.setEnabled(isEnabled)
                guard isEnabled else {
                    return
                }
                Task {
                    await petStore.loadPetsIfNeeded(codex: codex)
                    await petStore.loadSelectedPet(codex: codex)
                }
            }
        )
    }

    var selectedPetBinding: Binding<String> {
        Binding(
            get: { petStore.selectedPet?.id ?? "" },
            set: { selectedID in
                petStore.selectPet(id: selectedID.isEmpty ? nil : selectedID)
                Task {
                    await petStore.loadSelectedPet(codex: codex)
                }
            }
        )
    }
}
