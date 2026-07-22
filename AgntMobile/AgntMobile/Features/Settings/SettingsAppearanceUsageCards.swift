// FILE: SettingsAppearanceUsageCards.swift
// Purpose: Appearance, companion pet, and usage settings cards.
// Layer: View

import SwiftUI

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
            HStack {
                Text("Font")
                Spacer()
                Picker("Font", selection: $appFontStyle) {
                    ForEach(AppFont.Style.allCases) { style in
                        Text(style.title).tag(style)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .tint(settingsAccentColor)
            }

            Text(appFontStyle.subtitle)
                .font(AppFont.caption())
                .foregroundStyle(.secondary)

            HStack {
                Text("Message Bubble")
                Spacer()
                Menu {
                    ForEach(UserBubbleColor.allCases) { color in
                        Button {
                            HapticFeedback.shared.triggerImpactFeedback(style: .light)
                            userBubbleColorRawValue = color.rawValue
                        } label: {
                            Label {
                                Text(color.title)
                            } icon: {
                                Circle()
                                    .fill(color.swatchColor)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(selectedUserBubbleColor.swatchColor)
                            .frame(width: 14, height: 14)
                        Text(selectedUserBubbleColor.title)
                            .font(AppFont.callout())
                    }
                    .foregroundStyle(.primary)
                }
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
                    HStack {
                        Text("Pet")
                        Spacer()
                        Picker("Pet", selection: selectedPetBinding) {
                            ForEach(petStore.availablePets) { pet in
                                Text(pet.displayName).tag(pet.id)
                            }
                        }
                        .pickerStyle(.menu)
                        .labelsHidden()
                        .tint(settingsAccentColor)
                    }

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
