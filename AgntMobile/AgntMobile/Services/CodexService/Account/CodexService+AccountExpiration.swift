// FILE: CodexService+AccountExpiration.swift
// Purpose: Expiration helpers for persisted ChatGPT login state.
// Layer: Service

import Foundation

extension CodexGPTLoginState {
    var isExpired: Bool {
        guard let expiresAt else {
            return false
        }
        return expiresAt <= .now
    }
}

extension CodexGPTLoginCallbackState {
    var isExpired: Bool {
        createdAt.addingTimeInterval(10 * 60) <= .now
    }
}
