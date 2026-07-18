// FILE: TurnComposerInlineSkillToken.swift
// Purpose: Renders selected skill mentions as canonical attributed tokens in the composer.
// Layer: View Support
// Exports: TurnComposerInlineSkillToken
// Depends on: Foundation, UIKit, SkillDisplayNameFormatter

import Foundation
import UIKit

enum TurnComposerInlineSkillToken {
    static let attributeKey = NSAttributedString.Key("agnt.inlineSkillToken")

    private static let objectReplacementCharacter = "\u{FFFC}"

    static func displayAttributedString(
        canonicalText: String,
        mentionNames: [String],
        font: UIFont,
        textColor: UIColor,
        tintColor: UIColor
    ) -> NSAttributedString {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: textColor,
        ]
        let result = NSMutableAttributedString(string: canonicalText, attributes: attributes)
        let names = normalizedMentionNames(mentionNames)
        guard !names.isEmpty else { return result }

        let alternatives = names.map(NSRegularExpression.escapedPattern).joined(separator: "|")
        guard let regex = try? NSRegularExpression(
            pattern: "(?<!\\S)([$/])(\(alternatives))(?=[\\s,.;:!?)\\]}>]|$)",
            options: [.caseInsensitive]
        ) else {
            return result
        }

        let source = canonicalText as NSString
        let matches = regex.matches(in: canonicalText, range: NSRange(location: 0, length: source.length))
        for match in matches.reversed() {
            let canonicalToken = source.substring(with: match.range)
            let rawName = source.substring(with: match.range(at: 2))
            let displayName = SkillDisplayNameFormatter.displayName(for: rawName)
            let token = NSAttributedString(
                string: "$ \(displayName)",
                attributes: [
                    attributeKey: canonicalToken,
                    .font: font,
                    .foregroundColor: tintColor,
                ]
            )
            result.replaceCharacters(in: match.range, with: token)
        }
        return result
    }

    static func canonicalText(from attributedText: NSAttributedString) -> String {
        var result = ""
        let fullRange = NSRange(location: 0, length: attributedText.length)
        attributedText.enumerateAttribute(attributeKey, in: fullRange) { value, range, _ in
            if let token = value as? String {
                result += token
            } else {
                result += attributedText.attributedSubstring(from: range).string
                    .replacingOccurrences(of: objectReplacementCharacter, with: "")
            }
        }
        return result
    }

    static func expandedEditingRange(for range: NSRange, in attributedText: NSAttributedString) -> NSRange {
        guard range.length > 0 else { return range }
        var expanded = range
        let fullRange = NSRange(location: 0, length: attributedText.length)
        attributedText.enumerateAttribute(attributeKey, in: fullRange) { value, tokenRange, _ in
            guard value != nil, NSIntersectionRange(expanded, tokenRange).length > 0 else { return }
            expanded = NSUnionRange(expanded, tokenRange)
        }
        return expanded
    }

    static func snappedSelection(_ range: NSRange, in attributedText: NSAttributedString) -> NSRange {
        guard range.length == 0 else {
            return expandedEditingRange(for: range, in: attributedText)
        }

        var location = min(range.location, attributedText.length)
        let fullRange = NSRange(location: 0, length: attributedText.length)
        attributedText.enumerateAttribute(attributeKey, in: fullRange) { value, tokenRange, stop in
            guard value != nil, location > tokenRange.location, location < NSMaxRange(tokenRange) else {
                return
            }
            let distanceToStart = location - tokenRange.location
            let distanceToEnd = NSMaxRange(tokenRange) - location
            location = distanceToStart < distanceToEnd ? tokenRange.location : NSMaxRange(tokenRange)
            stop.pointee = true
        }
        return NSRange(location: location, length: 0)
    }

    @discardableResult
    static func normalizeTokenAttributes(in storage: NSMutableAttributedString) -> Bool {
        var rangesToStrip: [NSRange] = []
        let fullRange = NSRange(location: 0, length: storage.length)
        storage.enumerateAttribute(attributeKey, in: fullRange) { value, range, _ in
            guard let canonicalToken = value as? String else { return }
            let name = String(canonicalToken.dropFirst())
            let expected = "$ \(SkillDisplayNameFormatter.displayName(for: name))"
            let displayed = storage.attributedSubstring(from: range).string
            guard displayed.hasPrefix(expected) else {
                rangesToStrip.append(range)
                return
            }
            let expectedLength = (expected as NSString).length
            if range.length > expectedLength {
                rangesToStrip.append(NSRange(location: range.location + expectedLength, length: range.length - expectedLength))
            }
        }
        for range in rangesToStrip {
            storage.removeAttribute(attributeKey, range: range)
        }
        return !rangesToStrip.isEmpty
    }

    private static func normalizedMentionNames(_ names: [String]) -> [String] {
        Array(Set(names.compactMap { name -> String? in
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        })).sorted { $0.count > $1.count }
    }
}
