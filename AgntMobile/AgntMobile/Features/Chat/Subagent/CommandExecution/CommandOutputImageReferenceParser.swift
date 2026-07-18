// FILE: CommandOutputImageReferenceParser.swift
// Purpose: Command output and shell-token image path extraction.
// Layer: View Components

import SwiftUI

enum CommandOutputImageReferenceParser {
    nonisolated private static let imageExtensions: Set<String> = [
        "jpg", "jpeg", "png", "gif", "webp", "heic", "heif"
    ]
    private static let wildcardCharacters = CharacterSet(charactersIn: "*?")

    // Extracts a local image path without touching disk; the bridge validates and reads it on tap.
    static func firstReference(
        command: String,
        outputTail: String,
        cwd: String? = nil
    ) -> CommandOutputImageReference? {
        let listingDirectory = listingDirectory(from: command, cwd: cwd)
        for candidate in outputCandidates(from: outputTail) {
            if let path = normalizedImagePath(candidate, relativeTo: listingDirectory ?? cwd) {
                return CommandOutputImageReference(path: path)
            }
        }

        for candidate in commandCandidates(from: command) {
            if let path = normalizedImagePath(candidate, relativeTo: cwd) {
                return CommandOutputImageReference(path: path)
            }
        }

        return nil
    }

    private static func outputCandidates(from outputTail: String) -> [String] {
        var candidates = markdownLinkTargets(in: outputTail)
        let lines = outputTail
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
        candidates.append(contentsOf: lines)
        candidates.append(contentsOf: absoluteImagePathMatches(in: outputTail))
        return candidates
    }

    private static func commandCandidates(from command: String) -> [String] {
        shellTokens(from: unwrapShellCommand(command))
    }

    private static func markdownLinkTargets(in text: String) -> [String] {
        let pattern = #"!?\[[^\]]*\]\(([^)]+)\)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return []
        }
        let nsText = text as NSString
        return regex.matches(in: text, range: NSRange(location: 0, length: nsText.length)).compactMap { match in
            guard match.numberOfRanges > 1 else { return nil }
            return nsText.substring(with: match.range(at: 1))
        }
    }

    private static func absoluteImagePathMatches(in text: String) -> [String] {
        let extensionAlternation = imageExtensions.joined(separator: "|")
        let pattern = #"(?i)(file://)?(/[^\s\]\)"'`]+\.("#
            + extensionAlternation
            + #"))"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return []
        }
        let nsText = text as NSString
        return regex.matches(in: text, range: NSRange(location: 0, length: nsText.length)).compactMap { match in
            guard match.numberOfRanges > 2 else { return nil }
            return nsText.substring(with: match.range(at: 2))
        }
    }

    private static func normalizedImagePath(_ raw: String, relativeTo baseDirectory: String?) -> String? {
        var candidate = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "\"'`()[]{}<>"))

        guard !containsWildcardSyntax(candidate) else {
            return nil
        }

        while let last = candidate.last, ",.;:".contains(last) {
            candidate.removeLast()
        }

        if candidate.hasPrefix("file://") {
            candidate = String(candidate.dropFirst("file://".count))
        }
        candidate = candidate.removingPercentEncoding ?? candidate
        guard !containsWildcardSyntax(candidate) else {
            return nil
        }

        guard isImagePath(candidate) else {
            return nil
        }

        if candidate.hasPrefix("/") {
            return candidate
        }

        guard let baseDirectory,
              baseDirectory.hasPrefix("/") else {
            return nil
        }
        return (baseDirectory as NSString).appendingPathComponent(candidate)
    }

    nonisolated static func isImagePath(_ path: String) -> Bool {
        let ext = (path as NSString).pathExtension.lowercased()
        return imageExtensions.contains(ext)
    }

    private static func containsWildcardSyntax(_ value: String) -> Bool {
        value.rangeOfCharacter(from: wildcardCharacters) != nil
    }

    private static func listingDirectory(from command: String, cwd: String?) -> String? {
        let tokens = shellTokens(from: unwrapShellCommand(command))
        guard let tool = tokens.first.map({ ($0 as NSString).lastPathComponent.lowercased() }),
              tool == "ls" else {
            return nil
        }

        let pathCandidates = tokens.dropFirst().filter { token in
            !token.hasPrefix("-")
        }
        guard let listedPath = pathCandidates.last else {
            return cwd
        }
        if isImagePath(listedPath) {
            return (listedPath as NSString).deletingLastPathComponent
        }
        if listedPath.hasPrefix("/") {
            return listedPath
        }
        guard let cwd, cwd.hasPrefix("/") else {
            return nil
        }
        return (cwd as NSString).appendingPathComponent(listedPath)
    }

    private static func unwrapShellCommand(_ raw: String) -> String {
        let tokens = shellTokens(from: raw)
        guard !tokens.isEmpty else {
            return raw.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        let shellNames = ["bash", "zsh", "sh", "fish"]
        var shellIndex = 0
        if tokens.count >= 2 {
            let first = (tokens[0] as NSString).lastPathComponent.lowercased()
            let second = (tokens[1] as NSString).lastPathComponent.lowercased()
            if first == "env", shellNames.contains(second) {
                shellIndex = 1
            }
        }

        let shell = (tokens[shellIndex] as NSString).lastPathComponent.lowercased()
        guard shellNames.contains(shell) else {
            return raw.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        var index = shellIndex + 1
        while index < tokens.count {
            let token = tokens[index]
            if ["-c", "-lc", "-cl", "-ic", "-ci"].contains(token) {
                let commandStart = index + 1
                guard commandStart < tokens.count else {
                    return raw.trimmingCharacters(in: .whitespacesAndNewlines)
                }
                return tokens[commandStart...].joined(separator: " ")
            }
            index += 1
        }

        return raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func shellTokens(from value: String) -> [String] {
        var tokens: [String] = []
        var buffer = ""
        var quote: Character?
        var isEscaping = false

        for character in value {
            if isEscaping {
                buffer.append(character)
                isEscaping = false
                continue
            }
            if character == "\\" {
                isEscaping = true
                continue
            }
            if let activeQuote = quote {
                if character == activeQuote {
                    quote = nil
                } else {
                    buffer.append(character)
                }
                continue
            }
            if character == "\"" || character == "'" {
                quote = character
                continue
            }
            if character.isWhitespace {
                if !buffer.isEmpty {
                    tokens.append(buffer)
                    buffer = ""
                }
                continue
            }
            buffer.append(character)
        }

        if !buffer.isEmpty {
            tokens.append(buffer)
        }
        return tokens
    }
}
