// FILE: CodexService+LocalNetwork.swift
// Purpose: Local-network relay authorization and direct transport host classification.
// Layer: Service

import Foundation

extension CodexService {
    var isRunningOnSimulator: Bool {
#if targetEnvironment(simulator)
        true
#else
        false
#endif
    }

    func isLoopbackHost(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else {
            return false
        }
        if host == "localhost" || host == "::1" {
            return true
        }
        return host == "127.0.0.1" || host.hasPrefix("127.")
    }

    // Triggers iOS local-network privacy before dialing LAN relay hosts so pairing
    // does not fail with an opaque socket wait when the permission prompt was never shown.
    func requestLocalNetworkAuthorizationIfNeeded(for url: URL) async throws {
        guard requiresLocalNetworkAuthorization(for: url),
              localNetworkAuthorizationStatus != .granted else {
            return
        }

        let requester = LocalNetworkAuthorizationRequester()
        let status = await requester.request()
        localNetworkAuthorizationStatus = status

        guard status != .denied else {
            let message =
                "agnt is not allowed to access your local network. Enable Local Network for agnt in iPhone Settings and try again."
            lastErrorMessage = message
            throw CodexServiceError.invalidInput(message)
        }
    }

    func requiresLocalNetworkAuthorization(for url: URL) -> Bool {
        guard let host = url.host?.lowercased() else {
            return false
        }

        return host.hasSuffix(".local")
            || isPrivateIPv4Host(host)
            || isLocalIPv6Host(host)
    }

    // Chooses the most direct relay transport for LAN-style hosts plus private overlays like Tailscale.
    // Tailscale's 100.64.0.0/10 range should bypass the WebSocket URL path that iOS may proxy.
    func prefersDirectRelayTransport(for url: URL) -> Bool {
        guard let host = url.host?.lowercased() else {
            return false
        }

        return host.hasSuffix(".local")
            || isPrivateIPv4Host(host)
            || isCarrierGradePrivateIPv4Host(host)
            || isTailscaleMagicDNSHost(host)
            || isLocalIPv6Host(host)
    }

    func isPrivateIPv4Host(_ host: String) -> Bool {
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4 else {
            return false
        }

        switch (octets[0], octets[1]) {
        case (10, _):
            return true
        case (172, 16...31):
            return true
        case (192, 168):
            return true
        case (169, 254):
            return true
        default:
            return false
        }
    }

    // Covers CGNAT/private-overlay ranges like Tailscale's default 100.x addresses.
    func isCarrierGradePrivateIPv4Host(_ host: String) -> Bool {
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4 else {
            return false
        }

        return octets[0] == 100 && (64...127).contains(octets[1])
    }

    // Covers Tailscale hostnames that still resolve to the local/private overlay even without a raw 100.x QR URL.
    func isTailscaleMagicDNSHost(_ host: String) -> Bool {
        host.hasSuffix(".ts.net") || host.hasSuffix(".beta.tailscale.net")
    }

    func isLocalIPv6Host(_ host: String) -> Bool {
        let normalized = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        return normalized.hasPrefix("fe80:")
            || normalized.hasPrefix("fc")
            || normalized.hasPrefix("fd")
    }
}
