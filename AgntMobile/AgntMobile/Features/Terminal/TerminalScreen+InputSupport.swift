// FILE: TerminalScreen+InputSupport.swift
// Purpose: Pure terminal input helpers for modifier keys and paste chunking.
// Layer: View support
// Exports: TerminalScreen input helper APIs
// Depends on: Foundation

import Foundation

extension TerminalScreen {
    static func applyCtrlModifier(_ input: String) -> String {
        guard let firstCharacter = input.first else {
            return input
        }

        let lowerCharacter = Character(firstCharacter.lowercased())
        if let scalar = lowerCharacter.unicodeScalars.first,
           lowerCharacter >= "a",
           lowerCharacter <= "z" {
            return String(UnicodeScalar(scalar.value - 96) ?? scalar)
        }

        switch firstCharacter {
        case "@": return "\u{0}"
        case "[": return "\u{1B}"
        case "\\": return "\u{1C}"
        case "]": return "\u{1D}"
        case "^": return "\u{1E}"
        case "_": return "\u{1F}"
        case "?": return "\u{7F}"
        default: return input
        }
    }

    static func terminalPasteInputChunks(
        for text: String,
        bracketedPasteEnabled: Bool,
        maxChunkBytes: Int = 8_192
    ) -> [Data] {
        let normalizedText = normalizedTerminalPasteText(text)
        let wrappedText = bracketedPasteEnabled
            ? "\u{1B}[200~\(normalizedText)\u{1B}[201~"
            : normalizedText

        return Data(wrappedText.utf8).terminalPasteChunks(maxChunkBytes: maxChunkBytes)
    }

    private static func normalizedTerminalPasteText(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\r\n", with: "\r")
            .replacingOccurrences(of: "\n", with: "\r")
            .replacingOccurrences(of: "\u{0}", with: "")
            // Strip embedded bracketed-paste delimiters so clipboard content cannot
            // prematurely close the wrapper and turn the rest into typed commands.
            .replacingOccurrences(of: "\u{1B}[200~", with: "")
            .replacingOccurrences(of: "\u{1B}[201~", with: "")
    }
}

private extension Data {
    func terminalPasteChunks(maxChunkBytes: Int) -> [Data] {
        guard !isEmpty else { return [] }
        let safeChunkSize = Swift.max(1, maxChunkBytes)
        guard count > safeChunkSize else { return [self] }

        var chunks: [Data] = []
        chunks.reserveCapacity((count + safeChunkSize - 1) / safeChunkSize)

        var offset = 0
        while offset < count {
            let end = Swift.min(offset + safeChunkSize, count)
            chunks.append(subdata(in: offset..<end))
            offset = end
        }

        return chunks
    }
}
