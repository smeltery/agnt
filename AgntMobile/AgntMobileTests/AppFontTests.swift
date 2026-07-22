// FILE: AppFontTests.swift
// Purpose: Guards selectable app font styles and persisted style decoding.
// Layer: Unit Test
// Exports: AppFontTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

final class AppFontTests: XCTestCase {
    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: AppFont.storageKey)
        UserDefaults.standard.removeObject(forKey: AppFont.legacyStorageKey)
        UserDefaults.standard.removeObject(forKey: UserBubbleColor.storageKey)
        super.tearDown()
    }

    func testRoundedSystemStyleIsSelectable() {
        XCTAssertTrue(AppFont.Style.allCases.contains(.systemRounded))
        XCTAssertEqual(AppFont.Style.systemRounded.rawValue, "systemRounded")
        XCTAssertEqual(AppFont.Style.systemRounded.title, "SF Pro Rounded")
    }

    func testCurrentStyleReadsRoundedSystemPreference() {
        UserDefaults.standard.set(AppFont.Style.systemRounded.rawValue, forKey: AppFont.storageKey)

        XCTAssertEqual(AppFont.currentStyle, .systemRounded)
    }

    func testUserBubbleColorDefaultStorageValue() {
        XCTAssertEqual(UserBubbleColor.defaultStoredRawValue, "default")
        XCTAssertEqual(UserBubbleColor.storageKey, "agnt.userBubbleColor")
        XCTAssertEqual(UserBubbleColor(rawValue: ""), nil)
    }

    func testUserBubbleColorIncludesRemodexPaletteOptions() {
        XCTAssertEqual(UserBubbleColor.allCases.map(\.rawValue), [
            "default",
            "red",
            "orange",
            "yellow",
            "green",
            "mint",
            "blue",
            "indigo",
            "teal",
            "cyan",
            "pink",
            "purple",
            "brown",
            "black",
        ])
    }
}
