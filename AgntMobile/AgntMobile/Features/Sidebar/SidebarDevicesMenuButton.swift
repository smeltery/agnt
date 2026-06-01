// FILE: SidebarDevicesMenuButton.swift
// Purpose: Auto-hiding sidebar device switcher. Surfaces visible paired devices for
//          quick switching and an entry into the connections settings sheet. Visibility
//          follows the MyDeviceSwitcherVisibilityMode preference.
// Layer: View Component
// Exports: SidebarDevicesMenuButton
// Depends on: SwiftUI, CodexService, MyDevicesPresentation

import SwiftUI

struct SidebarDevicesMenuButton: View {
    @Environment(CodexService.self) private var codex
    let colorScheme: ColorScheme
    let isSwitchingMac: Bool
    let switchingMacDeviceId: String?
    let onSelectDevice: (String) -> Void
    let onOpenDevicesSettings: () -> Void

    @AppStorage(MyDeviceSwitcherVisibilityStore.key)
    private var switcherModeRawValue = MyDeviceSwitcherVisibilityStore.defaultMode.rawValue

    var body: some View {
        if shouldShowDevicesMenu {
            Menu {
                ForEach(visibleDevices) { device in
                    deviceMenuButton(for: device)
                }

                Divider()

                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    onOpenDevicesSettings()
                } label: {
                    Label("Manage Connections", systemImage: "slider.horizontal.3")
                }
            } label: {
                menuLabel
            }
            .accessibilityLabel("Switch device")
        }
    }

    @ViewBuilder
    private func deviceMenuButton(for device: MyDeviceRowModel) -> some View {
        Button {
            handleSelect(device)
        } label: {
            Label {
                VStack(alignment: .leading, spacing: 0) {
                    Text(device.primaryName)
                    if !device.menuSubtitle.isEmpty {
                        Text(device.menuSubtitle)
                    }
                }
            } icon: {
                if device.isSwitching {
                    Image(systemName: "arrow.triangle.2.circlepath")
                } else if device.isCurrent {
                    Image(systemName: "checkmark.circle.fill")
                } else {
                    Image(systemName: MyDevicesPresentation.macIconSystemName)
                }
            }
        }
        .disabled(isSwitchingMac || device.isCurrent)
    }

    private var menuLabel: some View {
        Group {
            if isSwitchingMac {
                ProgressView()
                    .controlSize(.small)
            } else {
                Image(systemName: MyDevicesPresentation.macIconSystemName)
                    .font(AppFont.system(size: 17, weight: .semibold))
                    .foregroundStyle(colorScheme == .dark ? Color.white : Color.black)
            }
        }
        .frame(width: 44, height: 44)
        .adaptiveGlass(.regular, in: Circle())
        .contentShape(Circle())
    }

    private var visibleDevices: [MyDeviceRowModel] {
        MyDevicesPresentation
            .rowModels(from: codex, switchingDeviceId: switchingMacDeviceId)
            .filter(\.isVisibleInMenu)
    }

    private var shouldShowDevicesMenu: Bool {
        let visibleDeviceCount = visibleDevices.count
        switch switcherMode {
        case .automatic:
            return isSwitchingMac || visibleDeviceCount > 1
        case .always:
            return isSwitchingMac || visibleDeviceCount > 0
        case .hidden:
            return isSwitchingMac
        }
    }

    private var switcherMode: MyDeviceSwitcherVisibilityMode {
        MyDeviceSwitcherVisibilityMode(rawValue: switcherModeRawValue)
            ?? MyDeviceSwitcherVisibilityStore.defaultMode
    }

    private func handleSelect(_ device: MyDeviceRowModel) {
        guard !device.isCurrent, !isSwitchingMac else { return }
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        onSelectDevice(device.deviceId)
    }
}
