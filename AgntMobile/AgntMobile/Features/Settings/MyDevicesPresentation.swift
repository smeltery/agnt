// FILE: MyDevicesPresentation.swift
// Purpose: Shared device naming, status copy, sort order, and visibility
//          preferences for the sidebar device switcher and the connections sheet.
// Layer: View helper
// Exports: MyDevicesPresentation, MyDeviceRowModel, MyDeviceSwitcherVisibilityMode,
//          MyDeviceMenuVisibilityStore, MyDeviceSwitcherVisibilityStore
// Depends on: CodexService, SidebarComputerNicknameStore

import Foundation

struct MyDeviceRowModel: Identifiable {
    let deviceId: String
    let primaryName: String
    let secondaryName: String?
    let status: String
    let detail: String?
    let isCurrent: Bool
    let isConnected: Bool
    let isSwitching: Bool
    let isVisibleInMenu: Bool

    var id: String { deviceId }

    var menuSubtitle: String {
        [status, detail].compactMap { value in
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed?.isEmpty == false ? trimmed : nil
        }
        .joined(separator: " · ")
    }
}

enum MyDeviceSwitcherVisibilityMode: String, CaseIterable, Identifiable {
    case automatic
    case always
    case hidden

    var id: String { rawValue }

    var title: String {
        switch self {
        case .automatic:
            return "Automatic"
        case .always:
            return "Always"
        case .hidden:
            return "Hidden"
        }
    }
}

enum MyDevicesPresentation {
    static let macIconSystemName = "desktopcomputer"

    static func sortedRecords(from codex: CodexService) -> [CodexTrustedMacRecord] {
        codex.trustedMacRegistry.records.values.sorted { lhs, rhs in
            shouldSortBefore(lhs, rhs, codex: codex)
        }
    }

    static func rowModels(from codex: CodexService, switchingDeviceId: String?) -> [MyDeviceRowModel] {
        sortedRecords(from: codex).map { record in
            rowModel(for: record, codex: codex, switchingDeviceId: switchingDeviceId)
        }
    }

    static func rowModel(
        for trustedMac: CodexTrustedMacRecord,
        codex: CodexService,
        switchingDeviceId: String?
    ) -> MyDeviceRowModel {
        // Hoist computed values into locals so the struct initializer stays
        // trivially type-checkable (avoids Swift inference blowup on the
        // many-argument init).
        let identity = displayIdentity(for: trustedMac)
        let status = statusLabel(for: trustedMac, codex: codex, switchingDeviceId: switchingDeviceId)
        let detail = detailLabel(for: trustedMac, switchingDeviceId: switchingDeviceId)
        let deviceId = trustedMac.macDeviceId
        let isCurrent = deviceId == codex.normalizedCurrentTrustedMacDeviceId
        let isConnected = deviceId == codex.normalizedRelayMacDeviceId && codex.isConnected
        let isSwitching = deviceId == switchingDeviceId
        let isVisibleInMenu = MyDeviceMenuVisibilityStore.isVisible(deviceId)
        return MyDeviceRowModel(
            deviceId: deviceId,
            primaryName: identity.primaryName,
            secondaryName: identity.secondaryName,
            status: status,
            detail: detail,
            isCurrent: isCurrent,
            isConnected: isConnected,
            isSwitching: isSwitching,
            isVisibleInMenu: isVisibleInMenu
        )
    }

    private static func displayIdentity(
        for trustedMac: CodexTrustedMacRecord
    ) -> (primaryName: String, secondaryName: String?) {
        let nickname = SidebarComputerNicknameStore.nickname(for: trustedMac.macDeviceId)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let systemName = trustedMac.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)

        if !nickname.isEmpty, let systemName, !systemName.isEmpty {
            return (nickname, systemName)
        }

        if !nickname.isEmpty {
            return (nickname, nil)
        }

        if let systemName, !systemName.isEmpty {
            return (systemName, nil)
        }

        return ("Mac", nil)
    }

    private static func statusLabel(
        for trustedMac: CodexTrustedMacRecord,
        codex: CodexService,
        switchingDeviceId: String?
    ) -> String {
        if trustedMac.macDeviceId == switchingDeviceId {
            return "Switching"
        }
        if trustedMac.macDeviceId == codex.normalizedRelayMacDeviceId && codex.isConnected {
            return "Connected"
        }
        if trustedMac.macDeviceId == codex.normalizedCurrentTrustedMacDeviceId {
            return "Selected"
        }
        if trustedMac.macDeviceId == codex.normalizedPreviousTrustedMacDeviceId {
            return "Previous"
        }
        return "Saved"
    }

    private static func detailLabel(
        for trustedMac: CodexTrustedMacRecord,
        switchingDeviceId: String?
    ) -> String? {
        if trustedMac.macDeviceId == switchingDeviceId {
            return "Reloading chats…"
        }

        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        let referenceDate = trustedMac.lastUsedAt ?? trustedMac.lastPairedAt
        return formatter.localizedString(for: referenceDate, relativeTo: Date())
    }

    private static func shouldSortBefore(
        _ lhs: CodexTrustedMacRecord,
        _ rhs: CodexTrustedMacRecord,
        codex: CodexService
    ) -> Bool {
        let lhsIsCurrent = lhs.macDeviceId == codex.normalizedCurrentTrustedMacDeviceId
        let rhsIsCurrent = rhs.macDeviceId == codex.normalizedCurrentTrustedMacDeviceId
        if lhsIsCurrent != rhsIsCurrent {
            return lhsIsCurrent
        }

        let lhsIsRelay = lhs.macDeviceId == codex.normalizedRelayMacDeviceId
        let rhsIsRelay = rhs.macDeviceId == codex.normalizedRelayMacDeviceId
        if lhsIsRelay != rhsIsRelay {
            return lhsIsRelay
        }

        let lhsIsPrevious = lhs.macDeviceId == codex.normalizedPreviousTrustedMacDeviceId
        let rhsIsPrevious = rhs.macDeviceId == codex.normalizedPreviousTrustedMacDeviceId
        if lhsIsPrevious != rhsIsPrevious {
            return lhsIsPrevious
        }

        let lhsHasResolvedSession = hasResolvedTrustedSession(lhs)
        let rhsHasResolvedSession = hasResolvedTrustedSession(rhs)
        if lhsHasResolvedSession != rhsHasResolvedSession {
            return lhsHasResolvedSession
        }

        return trustedMacActivityDate(lhs) > trustedMacActivityDate(rhs)
    }

    private static func hasResolvedTrustedSession(_ trustedMac: CodexTrustedMacRecord) -> Bool {
        if trustedMac.lastResolvedAt != nil {
            return true
        }
        return trustedMac.lastResolvedSessionId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty == false
    }

    private static func trustedMacActivityDate(_ trustedMac: CodexTrustedMacRecord) -> Date {
        trustedMac.lastResolvedAt ?? trustedMac.lastUsedAt ?? trustedMac.lastPairedAt
    }
}

// Per-device opt-out for the sidebar switcher menu. Absence of a stored value means visible.
enum MyDeviceMenuVisibilityStore {
    private static let keyPrefix = "codex.myDevices.visibleInMenu."

    static func isVisible(_ deviceId: String?) -> Bool {
        guard let storageKey = storageKey(for: deviceId) else {
            return true
        }
        guard UserDefaults.standard.object(forKey: storageKey) != nil else {
            return true
        }
        return UserDefaults.standard.bool(forKey: storageKey)
    }

    static func setVisible(_ isVisible: Bool, for deviceId: String?) {
        guard let storageKey = storageKey(for: deviceId) else {
            return
        }
        UserDefaults.standard.set(isVisible, forKey: storageKey)
    }

    static func removePreference(for deviceId: String?) {
        guard let storageKey = storageKey(for: deviceId) else {
            return
        }
        UserDefaults.standard.removeObject(forKey: storageKey)
    }

    private static func storageKey(for deviceId: String?) -> String? {
        guard let deviceId = deviceId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !deviceId.isEmpty else {
            return nil
        }
        return keyPrefix + deviceId
    }
}

// Global preference controlling whether the sidebar switcher auto-hides, always shows, or stays hidden.
enum MyDeviceSwitcherVisibilityStore {
    static let key = "codex.myDevices.switcherVisibilityMode"
    static let defaultMode = MyDeviceSwitcherVisibilityMode.automatic

    static var mode: MyDeviceSwitcherVisibilityMode {
        get {
            guard let rawValue = UserDefaults.standard.string(forKey: key),
                  let mode = MyDeviceSwitcherVisibilityMode(rawValue: rawValue) else {
                return defaultMode
            }
            return mode
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: key)
        }
    }
}
