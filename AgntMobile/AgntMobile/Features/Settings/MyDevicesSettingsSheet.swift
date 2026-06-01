// FILE: MyDevicesSettingsSheet.swift
// Purpose: Native inset-grouped connections sheet with switcher visibility,
//          per-device controls, and an add-connection row.
// Layer: View
// Exports: MyDevicesSettingsSheet
// Depends on: SwiftUI, CodexService, MyDevicesPresentation

import SwiftUI

struct MyDevicesSettingsSheet: View {
    @Environment(CodexService.self) private var codex
    @Environment(\.dismiss) private var dismiss

    let isSwitchingMac: Bool
    let switchingDeviceId: String?
    let switchNotice: String?
    let onSelectDevice: (String) -> Void
    let onForgetDevice: (String) -> Void
    let onAddConnection: () -> Void
    let onCancelSwitch: () -> Void

    @State private var pendingForgetDeviceId: String?
    @State private var pendingSwitchDeviceId: String?
    @State private var visibilityPreferenceRevision = 0
    @AppStorage(MyDeviceSwitcherVisibilityStore.key)
    private var switcherModeRawValue = MyDeviceSwitcherVisibilityStore.defaultMode.rawValue

    private var devices: [MyDeviceRowModel] {
        // Re-read UserDefaults-backed visibility after toggles without moving the setting into view state.
        _ = visibilityPreferenceRevision
        return MyDevicesPresentation.rowModels(from: codex, switchingDeviceId: switchingDeviceId)
    }

    var body: some View {
        NavigationStack {
            List {
                if let switchNotice, !switchNotice.isEmpty {
                    Section {
                        Text(switchNotice)
                            .font(AppFont.caption())
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    Picker("Show switcher", selection: switcherModeBinding) {
                        ForEach(MyDeviceSwitcherVisibilityMode.allCases) { mode in
                            Text(mode.title)
                                .tag(mode)
                        }
                    }
                    .pickerStyle(.menu)
                } footer: {
                    Text("Automatic hides the sidebar switcher when only one visible device is paired.")
                }

                Section("Devices") {
                    if devices.isEmpty {
                        Text("No paired devices yet.")
                            .font(AppFont.subheadline())
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(devices) { device in
                            deviceRow(device)
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button("Forget", role: .destructive) {
                                        pendingForgetDeviceId = device.deviceId
                                    }
                                }
                        }
                    }

                    Button(action: handleAddConnection) {
                        Label {
                            Text("Add connection")
                                .foregroundStyle(Color.accentColor)
                        } icon: {
                            Image(systemName: "plus")
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                    .disabled(isSwitchingMac)
                }
            }
            .listStyle(.insetGrouped)
            .font(AppFont.body())
            .navigationTitle("Connections")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        dismiss()
                    }
                }
            }
            .overlay {
                if isSwitchingMac {
                    switchingOverlay
                }
            }
        }
        .confirmationDialog(
            "Switch Device?",
            isPresented: pendingSwitchDialogBinding,
            titleVisibility: .visible
        ) {
            Button("Switch Device", role: .destructive, action: confirmPendingSwitch)
            Button("Cancel", role: .cancel, action: cancelPendingSwitch)
        } message: {
            Text("Switching devices will disconnect the current session, stop any in-progress runs, and may discard unfinished output.")
        }
        .alert(
            "Forget this Device?",
            isPresented: pendingForgetAlertBinding,
            actions: {
                Button("Forget", role: .destructive, action: confirmPendingForget)
                Button("Cancel", role: .cancel, action: cancelPendingForget)
            },
            message: {
                Text("The paired device will be removed from this iPhone. Scan its QR code again to reconnect.")
            }
        )
    }

    @ViewBuilder
    private func deviceRow(_ device: MyDeviceRowModel) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                deviceIconBadge(for: device)

                VStack(alignment: .leading, spacing: 2) {
                    Text(device.primaryName)
                        .font(AppFont.body())
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    if !device.menuSubtitle.isEmpty {
                        Text(device.menuSubtitle)
                            .font(AppFont.caption())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 8)

                HStack(spacing: 14) {
                    forgetDeviceButton(for: device)
                    deviceSelectionControl(for: device)
                }
            }

            Toggle("Show in sidebar switcher", isOn: toggleBinding(for: device))
                .font(AppFont.caption())
                .disabled(isSwitchingMac)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func deviceIconBadge(for device: MyDeviceRowModel) -> some View {
        Image(systemName: MyDevicesPresentation.macIconSystemName)
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(device.isConnected ? Color.green : Color.secondary)
            .frame(width: 32, height: 32)
            .background(
                Circle()
                    .fill(device.isConnected ? Color.green.opacity(0.16) : Color(.tertiarySystemFill))
            )
    }

    @ViewBuilder
    private func deviceSelectionControl(for device: MyDeviceRowModel) -> some View {
        Group {
            if device.isSwitching {
                ProgressView()
                    .controlSize(.small)
            } else if device.isCurrent {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.primary)
            } else {
                Button(action: { handleChooseDevice(device) }) {
                    Image(systemName: "circle")
                        .font(.system(size: 18, weight: .regular))
                        .foregroundStyle(Color(.tertiaryLabel))
                }
                .buttonStyle(.plain)
                .disabled(isSwitchingMac)
            }
        }
        .frame(width: 22, height: 22)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(device.isCurrent ? "Selected device" : "Select device")
        .accessibilityAddTraits(device.isCurrent ? [.isSelected] : .isButton)
    }

    private func toggleBinding(for device: MyDeviceRowModel) -> Binding<Bool> {
        Binding(
            get: {
                MyDeviceMenuVisibilityStore.isVisible(device.deviceId)
            },
            set: { isOn in
                updateMenuVisibility(isOn, for: device)
            }
        )
    }

    private var switcherModeBinding: Binding<MyDeviceSwitcherVisibilityMode> {
        Binding(
            get: {
                MyDeviceSwitcherVisibilityMode(rawValue: switcherModeRawValue)
                    ?? MyDeviceSwitcherVisibilityStore.defaultMode
            },
            set: { mode in
                switcherModeRawValue = mode.rawValue
            }
        )
    }

    private func forgetDeviceButton(for device: MyDeviceRowModel) -> some View {
        Button(role: .destructive) {
            pendingForgetDeviceId = device.deviceId
        } label: {
            Image(systemName: "trash")
                .font(.system(size: 16, weight: .semibold))
        }
        .foregroundStyle(Color.red)
        .buttonStyle(.plain)
        .disabled(isSwitchingMac)
        .accessibilityLabel("Forget device")
    }

    private var switchingOverlay: some View {
        ZStack {
            Color.black.opacity(0.08)
                .ignoresSafeArea()

            VStack(spacing: 12) {
                ProgressView()
                Text("Switching Device…")
                    .font(AppFont.subheadline(weight: .semibold))
                if let deviceName = devices.first(where: \.isSwitching)?.primaryName {
                    Text(deviceName)
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                }
                Button("Cancel", action: onCancelSwitch)
                    .font(AppFont.body(weight: .semibold))
            }
            .padding(20)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .padding(.horizontal, 40)
        }
    }

    private var pendingForgetAlertBinding: Binding<Bool> {
        Binding(
            get: { pendingForgetDeviceId != nil },
            set: { isPresented in
                if !isPresented {
                    pendingForgetDeviceId = nil
                }
            }
        )
    }

    private var pendingSwitchDialogBinding: Binding<Bool> {
        Binding(
            get: { pendingSwitchDeviceId != nil },
            set: { isPresented in
                if !isPresented {
                    pendingSwitchDeviceId = nil
                }
            }
        )
    }

    private func handleAddConnection() {
        guard !isSwitchingMac else { return }
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        dismiss()
        onAddConnection()
    }

    private func updateMenuVisibility(_ isVisible: Bool, for device: MyDeviceRowModel) {
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        MyDeviceMenuVisibilityStore.setVisible(isVisible, for: device.deviceId)
        visibilityPreferenceRevision += 1
    }

    private var requiresSwitchConfirmation: Bool {
        !codex.runningThreadIDs.isEmpty
            || !codex.protectedRunningFallbackThreadIDs.isEmpty
            || !codex.activeTurnIdByThread.isEmpty
    }

    private func handleChooseDevice(_ device: MyDeviceRowModel) {
        guard !device.isCurrent, !isSwitchingMac else { return }

        if requiresSwitchConfirmation {
            pendingSwitchDeviceId = device.deviceId
            return
        }

        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        onSelectDevice(device.deviceId)
    }

    private func confirmPendingSwitch() {
        if let pendingSwitchDeviceId {
            onSelectDevice(pendingSwitchDeviceId)
        }
        pendingSwitchDeviceId = nil
    }

    private func cancelPendingSwitch() {
        pendingSwitchDeviceId = nil
    }

    private func confirmPendingForget() {
        if let pendingForgetDeviceId {
            MyDeviceMenuVisibilityStore.removePreference(for: pendingForgetDeviceId)
            onForgetDevice(pendingForgetDeviceId)
        }
        pendingForgetDeviceId = nil
    }

    private func cancelPendingForget() {
        pendingForgetDeviceId = nil
    }
}
