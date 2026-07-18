// FILE: BridgeMenuBarQRCodeView.swift
// Purpose: Renders the menu bar pairing QR code and encodes its wire payload.
// Layer: Companion app view
// Exports: PairingQRCodeView
// Depends on: SwiftUI, AppKit, CoreImage, BridgeControlModels

import AppKit
import CoreImage.CIFilterBuiltins
import SwiftUI

struct PairingQRCodeView: View {
    let payload: BridgePairingPayload
    private let context = CIContext()
    private let filter = CIFilter.qrCodeGenerator()

    var body: some View {
        Group {
            if let image = qrImage {
                Image(nsImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .padding(8)
            } else {
                Text("QR unavailable")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var qrImage: NSImage? {
        let payloadObject = PairingQRPayloadEnvelope(
            v: payload.v,
            relay: payload.relay,
            sessionId: payload.sessionId,
            macDeviceId: payload.macDeviceId,
            macIdentityPublicKey: payload.macIdentityPublicKey,
            expiresAt: payload.expiresAt
        )
        guard let data = try? JSONEncoder().encode(payloadObject) else { return nil }

        filter.setValue(data, forKey: "inputMessage")
        filter.correctionLevel = "M"

        guard let outputImage = filter.outputImage else { return nil }
        let scaledImage = outputImage.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        guard let cgImage = context.createCGImage(scaledImage, from: scaledImage.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: .zero)
    }
}

private struct PairingQRPayloadEnvelope: Encodable {
    let v: Int
    let relay: String
    let sessionId: String
    let macDeviceId: String
    let macIdentityPublicKey: String
    let expiresAt: Int64
}
