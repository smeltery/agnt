// FILE: BridgeControlTrustFallback.swift
// Purpose: Decodes legacy local device trust state for menu bar status fallbacks.
// Layer: Companion app service
// Exports: LegacyBridgeDeviceState, shortFingerprint, normalizeDeviceKind
// Depends on: CryptoKit, Foundation

import CryptoKit
import Foundation

struct LegacyBridgeDeviceState: Decodable {
    let macDeviceId: String?
    let trustedPhones: [String: String]
    let lastSeenDeviceKind: String?
    let lastSeenPhoneAppVersion: String?

    private enum CodingKeys: String, CodingKey {
        case macDeviceId
        case trustedPhones
        case lastSeenDeviceKind
        case lastSeenPhoneAppVersion
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        macDeviceId = try container.decodeIfPresent(String.self, forKey: .macDeviceId)
        trustedPhones = try container.decodeIfPresent([String: String].self, forKey: .trustedPhones) ?? [:]
        lastSeenDeviceKind = try container.decodeIfPresent(String.self, forKey: .lastSeenDeviceKind)
        lastSeenPhoneAppVersion = try container.decodeIfPresent(String.self, forKey: .lastSeenPhoneAppVersion)
    }
}

func normalizeDeviceKind(_ value: String?) -> String? {
    guard let normalized = normalizeNonEmptyFingerprintInput(value)?.lowercased() else {
        return nil
    }

    switch normalized {
    case "ios", "iphone":
        return "iphone"
    case "android":
        return "android"
    case "mac", "macos", "darwin":
        return "mac"
    default:
        return normalized
    }
}

func shortFingerprint(_ value: String?) -> String? {
    guard let normalized = normalizeNonEmptyFingerprintInput(value) else {
        return nil
    }

    let digest = SHA256.hash(data: Data(normalized.utf8))
    return digest.prefix(4).map { String(format: "%02x", $0) }.joined()
}

private func normalizeNonEmptyFingerprintInput(_ value: String?) -> String? {
    guard let value else {
        return nil
    }

    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}
