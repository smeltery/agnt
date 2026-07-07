// FILE: MyDevicesPresentationTests.swift
// Purpose: Verifies device row-model derivation, sort order, and switcher visibility logic.
// Layer: Unit Test
// Exports: MyDevicesPresentationTests
// Depends on: XCTest, AgntMobile

import Foundation
import XCTest
@testable import AgntMobile

@MainActor
final class MyDevicesPresentationTests: XCTestCase {
    private static var retainedServices: [CodexService] = []
    private var touchedVisibilityDeviceIDs: [String] = []

    override func tearDown() {
        for deviceId in touchedVisibilityDeviceIDs {
            MyDeviceMenuVisibilityStore.removePreference(for: deviceId)
        }
        touchedVisibilityDeviceIDs.removeAll()
        super.tearDown()
    }

    func testRowModelMarksCurrentDeviceSelected() {
        let service = makeService()
        let currentID = registerRecord(in: service, displayName: "Studio")
        service.setCurrentTrustedMacDeviceId(currentID)

        let rows = MyDevicesPresentation.rowModels(from: service, switchingDeviceId: nil)
        let currentRow = try? XCTUnwrap(rows.first { $0.deviceId == currentID })

        XCTAssertEqual(currentRow?.status, "Selected")
        XCTAssertTrue(currentRow?.isCurrent == true)
        XCTAssertEqual(currentRow?.primaryName, "Studio")
    }

    func testRowModelReportsSwitchingState() {
        let service = makeService()
        let deviceID = registerRecord(in: service, displayName: "Laptop")

        let rows = MyDevicesPresentation.rowModels(from: service, switchingDeviceId: deviceID)
        let row = try? XCTUnwrap(rows.first { $0.deviceId == deviceID })

        XCTAssertEqual(row?.status, "Switching")
        XCTAssertEqual(row?.detail, "Reloading chats…")
        XCTAssertTrue(row?.isSwitching == true)
    }

    func testSortPlacesCurrentDeviceFirst() {
        let service = makeService()
        let olderID = registerRecord(in: service, displayName: "Older", lastPairedAt: Date().addingTimeInterval(-100))
        let currentID = registerRecord(in: service, displayName: "Current", lastPairedAt: Date().addingTimeInterval(-500))
        service.setCurrentTrustedMacDeviceId(currentID)

        let sorted = MyDevicesPresentation.sortedRecords(from: service)

        XCTAssertEqual(sorted.first?.macDeviceId, currentID)
        XCTAssertTrue(sorted.contains { $0.macDeviceId == olderID })
    }

    func testMenuVisibilityDefaultsToVisibleAndHonorsOptOut() {
        let service = makeService()
        let deviceID = registerRecord(in: service, displayName: "Hidden Candidate")

        var rows = MyDevicesPresentation.rowModels(from: service, switchingDeviceId: nil)
        XCTAssertTrue(rows.first { $0.deviceId == deviceID }?.isVisibleInMenu == true)

        markVisibility(false, for: deviceID)
        rows = MyDevicesPresentation.rowModels(from: service, switchingDeviceId: nil)
        XCTAssertTrue(rows.first { $0.deviceId == deviceID }?.isVisibleInMenu == false)
    }

    func testSwitcherVisibilityModeTitlesAreStable() {
        XCTAssertEqual(MyDeviceSwitcherVisibilityMode.automatic.title, "Automatic")
        XCTAssertEqual(MyDeviceSwitcherVisibilityMode.always.title, "Always")
        XCTAssertEqual(MyDeviceSwitcherVisibilityMode.hidden.title, "Hidden")
        XCTAssertEqual(MyDeviceSwitcherVisibilityMode.allCases.count, 3)
    }

    // MARK: - Helpers

    @discardableResult
    private func registerRecord(
        in service: CodexService,
        displayName: String,
        lastPairedAt: Date = Date()
    ) -> String {
        let deviceID = "mac-\(UUID().uuidString)"
        service.trustedMacRegistry.records[deviceID] = CodexTrustedMacRecord(
            macDeviceId: deviceID,
            macIdentityPublicKey: Data(repeating: 9, count: 32).base64EncodedString(),
            lastPairedAt: lastPairedAt,
            displayName: displayName
        )
        return deviceID
    }

    private func markVisibility(_ isVisible: Bool, for deviceId: String) {
        MyDeviceMenuVisibilityStore.setVisible(isVisible, for: deviceId)
        touchedVisibilityDeviceIDs.append(deviceId)
    }

    private func makeService() -> CodexService {
        let suiteName = "MyDevicesPresentationTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        Self.retainedServices.append(service)
        return service
    }
}
