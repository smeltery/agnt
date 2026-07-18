// FILE: TurnViewModel+FileMentionAliases.swift
// Purpose: Builds normalized file mention aliases and ambiguity keys for composer autocomplete.
// Layer: View Model Extension
// Exports: TurnViewModel file mention alias helpers
// Depends on: Foundation, TurnComposerMentionedFile

import Foundation

// Splits contiguous filename segments into search-friendly word chunks.
private let turnFileMentionSegmentRegex = try? NSRegularExpression(
    pattern: #"[A-Z]+(?=$|[A-Z][a-z]|\d)|[A-Z]?[a-z]+|\d+"#
)

extension TurnViewModel {
    // Generates raw and normalized aliases so matching survives spaces, separators, and casing changes.
    static func fileMentionAliases(
        fileName: String,
        path: String,
        allowFileNameAliases: Bool = true
    ) -> [String] {
        var aliases: Set<String> = []
        var seeds = [path, deletingPathExtension(from: path)]

        if allowFileNameAliases {
            seeds.insert(fileName, at: 0)
            seeds.append(deletingPathExtension(from: fileName))
        }

        for seed in seeds {
            let trimmedSeed = seed.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedSeed.isEmpty else {
                continue
            }

            aliases.insert(trimmedSeed)
            appendNormalizedFileMentionAliases(for: trimmedSeed, into: &aliases)
        }

        return aliases
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .sorted {
                if $0.count == $1.count {
                    return $0.localizedCaseInsensitiveCompare($1) == .orderedAscending
                }
                return $0.count > $1.count
            }
    }

    // When multiple mentions normalize to the same basename, only folder-aware aliases are safe.
    static func ambiguousFileNameAliasKeys(in mentions: [TurnComposerMentionedFile]) -> Set<String> {
        let groupedKeys = Dictionary(grouping: mentions.compactMap { mention in
            fileNameAliasCollisionKey(for: mention.fileName)
        }) { $0 }

        return Set(groupedKeys.compactMap { key, bucket in
            bucket.count > 1 ? key : nil
        })
    }

    private static func appendNormalizedFileMentionAliases(
        for seed: String,
        into aliases: inout Set<String>
    ) {
        let trimmedSeed = seed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSeed.isEmpty else {
            return
        }

        let pathExtension = (trimmedSeed as NSString).pathExtension
        let normalizedExtension = pathExtension.lowercased()
        let stem = normalizedExtension.isEmpty
            ? trimmedSeed
            : (trimmedSeed as NSString).deletingPathExtension
        let tokens = mentionSearchTokens(from: stem)
        guard !tokens.isEmpty else {
            return
        }

        var baseVariants: Set<String> = [
            tokens.joined(separator: " "),
            tokens.joined(separator: "-"),
            tokens.joined(separator: "_"),
            tokens.joined(),
            lowerCamelCase(from: tokens),
            upperCamelCase(from: tokens),
        ]
        baseVariants = baseVariants.filter { !$0.isEmpty }

        for variant in baseVariants {
            aliases.insert(variant)
            if !normalizedExtension.isEmpty {
                aliases.insert("\(variant).\(normalizedExtension)")
            }
        }
    }

    private static func mentionSearchTokens(from value: String) -> [String] {
        let trimmedValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedValue.isEmpty else {
            return []
        }

        return trimmedValue
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .flatMap(tokensFromMentionSegment)
    }

    // Keeps Apple-style prefixes like `iOS` together so alias variants stay natural.
    private static func tokensFromMentionSegment(_ segment: String) -> [String] {
        let trimmedSegment = segment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSegment.isEmpty else {
            return []
        }

        guard let regex = turnFileMentionSegmentRegex else {
            return [trimmedSegment.lowercased()]
        }

        let range = NSRange(trimmedSegment.startIndex..., in: trimmedSegment)
        let rawTokens = regex.matches(in: trimmedSegment, range: range).compactMap { match in
            Range(match.range, in: trimmedSegment).map { String(trimmedSegment[$0]) }
        }
        guard !rawTokens.isEmpty else {
            return [trimmedSegment.lowercased()]
        }

        var normalizedTokens: [String] = []
        var index = 0

        while index < rawTokens.count {
            let token = rawTokens[index]

            if token.count == 1,
               token == token.lowercased(),
               index + 1 < rawTokens.count,
               isAllCapsAcronym(rawTokens[index + 1]) {
                normalizedTokens.append((token + rawTokens[index + 1]).lowercased())
                index += 2
                continue
            }

            normalizedTokens.append(token.lowercased())
            index += 1
        }

        return normalizedTokens
    }

    private static func isAllCapsAcronym(_ token: String) -> Bool {
        token.count > 1
            && token.unicodeScalars.allSatisfy {
                CharacterSet.uppercaseLetters.contains($0) || CharacterSet.decimalDigits.contains($0)
            }
    }

    private static func lowerCamelCase(from tokens: [String]) -> String {
        guard let first = tokens.first else {
            return ""
        }

        let tail = tokens.dropFirst().map(capitalizedToken).joined()
        return first + tail
    }

    private static func upperCamelCase(from tokens: [String]) -> String {
        tokens.map(capitalizedToken).joined()
    }

    private static func capitalizedToken(_ token: String) -> String {
        guard let first = token.first else {
            return token
        }

        return first.uppercased() + token.dropFirst()
    }

    private static func deletingPathExtension(from value: String) -> String {
        let trimmedValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedValue.isEmpty else {
            return ""
        }
        return (trimmedValue as NSString).deletingPathExtension
    }

    static func fileNameAliasCollisionKey(for fileName: String) -> String? {
        let trimmedName = fileName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            return nil
        }

        let normalizedExtension = (trimmedName as NSString).pathExtension.lowercased()
        let stem = deletingPathExtension(from: trimmedName)
        let tokens = mentionSearchTokens(from: stem)
        guard !tokens.isEmpty else {
            return normalizedExtension.isEmpty ? nil : ".\(normalizedExtension)"
        }

        let tokenKey = tokens.joined(separator: "|")
        return normalizedExtension.isEmpty ? tokenKey : "\(tokenKey).\(normalizedExtension)"
    }
}
