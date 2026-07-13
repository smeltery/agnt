// FILE: CodexService+HistoryImages.swift
// Purpose: Decodes generated and inline image payloads from thread/read history.
// Layer: Service Extension
// Exports: CodexService image history parsing helpers

import Foundation
import UIKit

extension CodexService {
    nonisolated private static let historyInlineImagePayloadStorageByteLimit = 12_000_000

    func decodeGeneratedImageMarkdown(from itemObject: [String: JSONValue]) -> String? {
        let imagePath = firstNonEmptyString([
            itemObject["saved_path"]?.stringValue,
            itemObject["savedPath"]?.stringValue,
            itemObject["path"]?.stringValue,
            itemObject["file_path"]?.stringValue
        ])?
        .trimmingCharacters(in: .whitespacesAndNewlines)

        guard let imagePath, Self.isGeneratedImagePath(imagePath) else {
            return nil
        }

        return "![Generated image](\(Self.markdownImagePath(imagePath)))"
    }

    nonisolated static func isGeneratedImagePath(_ path: String) -> Bool {
        let lowercased = path.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return lowercased.hasSuffix(".png")
            || lowercased.hasSuffix(".jpg")
            || lowercased.hasSuffix(".jpeg")
            || lowercased.hasSuffix(".gif")
            || lowercased.hasSuffix(".webp")
            || lowercased.hasSuffix(".heic")
            || lowercased.hasSuffix(".heif")
    }

    nonisolated static func markdownImagePath(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.contains(")") || trimmed.contains(" ") || trimmed.contains("%") {
            let escaped = trimmed
                .replacingOccurrences(of: "%", with: "%25")
                .replacingOccurrences(of: ">", with: "%3E")
                .replacingOccurrences(of: ")", with: "%29")
            return "<\(escaped)>"
        }
        return trimmed
    }

    // Extracts history image payloads into attachments. Small inline data URLs are preserved
    // so mobile can preview images that are outside the workspace allowlist.
    func decodeImageAttachments(from itemObject: [String: JSONValue]) -> [CodexImageAttachment] {
        let contentItems = itemObject["content"]?.arrayValue ?? []
        var attachments: [CodexImageAttachment] = []

        for value in contentItems {
            guard let object = value.objectValue else { continue }
            let rawType = object["type"]?.stringValue ?? ""
            let normalizedType = normalizedItemType(rawType)
            guard normalizedType == "image" || normalizedType == "localimage" else {
                continue
            }

            let sourceURL = object["url"]?.stringValue
                ?? object["image_url"]?.stringValue
                ?? object["path"]?.stringValue
            let payloadDataURL: String?
            if let sourceURL, sourceURL.lowercased().hasPrefix("data:image") {
                payloadDataURL = sourceURL
            } else {
                payloadDataURL = nil
            }

            let thumbnailBase64: String
            if let payloadDataURL,
               let rawImageData = decodeDataURIImageData(payloadDataURL),
               let thumbnail = makeThumbnailBase64JPEG(from: rawImageData) {
                thumbnailBase64 = thumbnail
            } else {
                thumbnailBase64 = ""
            }

            attachments.append(
                CodexImageAttachment(
                    thumbnailBase64JPEG: thumbnailBase64,
                    payloadDataURL: payloadDataURL,
                    sourceURL: sourceURL
                )
                .sanitizedForStorage(
                    preservingPayloadDataURL: shouldPreserveHistoryImagePayload(payloadDataURL)
                )
            )
        }

        return attachments
    }

    // Parses `data:image/...;base64,...` payloads into raw image bytes.
    func decodeDataURIImageData(_ dataURI: String) -> Data? {
        guard let commaIndex = dataURI.firstIndex(of: ",") else {
            return nil
        }

        let metadata = dataURI[..<commaIndex].lowercased()
        guard metadata.hasPrefix("data:image"),
              metadata.contains(";base64") else {
            return nil
        }

        let payloadStart = dataURI.index(after: commaIndex)
        let base64Part = String(dataURI[payloadStart...])
        return Data(base64Encoded: base64Part)
    }

    // Produces the persisted 70x70 JPEG thumbnail preview used in message rows.
    func makeThumbnailBase64JPEG(from imageData: Data, side: CGFloat = 70) -> String? {
        guard let image = UIImage(data: imageData) else {
            return nil
        }

        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side))
        let rendered = renderer.image { _ in
            let sourceSize = image.size
            let scale = max(side / sourceSize.width, side / sourceSize.height)
            let scaledSize = CGSize(width: sourceSize.width * scale, height: sourceSize.height * scale)
            let origin = CGPoint(
                x: (side - scaledSize.width) / 2,
                y: (side - scaledSize.height) / 2
            )
            image.draw(in: CGRect(origin: origin, size: scaledSize))
        }

        guard let jpegData = rendered.jpegData(compressionQuality: 0.8) else {
            return nil
        }

        return jpegData.base64EncodedString()
    }

    private func shouldPreserveHistoryImagePayload(_ payloadDataURL: String?) -> Bool {
        guard let payloadDataURL else { return false }
        return payloadDataURL.utf8.count <= Self.historyInlineImagePayloadStorageByteLimit
    }
}
