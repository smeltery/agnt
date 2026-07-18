// FILE: AssistantMarkdownImageReferences.swift
// Purpose: Markdown image reference model, segmentation, and preview path validation.
// Layer: View Components

import SwiftUI

struct AssistantMarkdownImageReference: Identifiable, Equatable {
    let id: String
    let path: String
    let altText: String

    nonisolated init(path: String, altText: String, occurrenceIndex: Int) {
        self.id = "\(occurrenceIndex)|\(path)"
        self.path = path
        self.altText = altText
    }

    var fileName: String { path.pathDisplayName }

    var displayTitle: String {
        let trimmedAlt = altText.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedAlt.isEmpty ? "Image" : trimmedAlt
    }

    var isTemporaryScreenshotImage: Bool {
        AssistantMarkdownImageReferenceParser.isTemporaryScreenshotImagePath(path)
    }

    nonisolated var isCodexGeneratedImage: Bool {
        AssistantMarkdownImageReferenceParser.isCodexGeneratedImagePath(path)
    }

    // Mirrors the bridge allowlist so timeline image cards do not advertise previews
    // that `workspace/readImage` will reject on tap.
    func canPreview(currentWorkingDirectory: String?) -> Bool {
        if isTemporaryScreenshotImage || isCodexGeneratedImage {
            return true
        }

        let normalizedPath = Self.normalizedLocalPath(path)
        guard !normalizedPath.isEmpty else {
            return false
        }

        guard let currentWorkingDirectory = currentWorkingDirectory,
              let resolvedPath = Self.workspaceResolvedPath(
                normalizedPath,
                currentWorkingDirectory: currentWorkingDirectory
              ) else {
            return false
        }

        return Self.isPath(resolvedPath, inside: currentWorkingDirectory)
    }

    private static func normalizedLocalPath(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\", with: "/")
    }

    private static func workspaceResolvedPath(_ path: String, currentWorkingDirectory: String) -> String? {
        let normalizedRoot = normalizedPathComponentsPath(currentWorkingDirectory)
        guard normalizedRoot.hasPrefix("/") else {
            return nil
        }

        if path.hasPrefix("/") {
            return normalizedPathComponentsPath(path)
        }

        return normalizedPathComponentsPath("\(normalizedRoot)/\(path)")
    }

    private static func isPath(_ path: String, inside root: String) -> Bool {
        let normalizedPath = normalizedPathComponentsPath(path)
        var normalizedRoot = normalizedPathComponentsPath(root)
        while normalizedRoot.count > 1, normalizedRoot.hasSuffix("/") {
            normalizedRoot.removeLast()
        }
        guard normalizedRoot != "/" else {
            return normalizedPath.hasPrefix("/")
        }
        return normalizedPath == normalizedRoot || normalizedPath.hasPrefix("\(normalizedRoot)/")
    }

    // Resolves "." and ".." lexically; the Mac bridge still does the authoritative realpath check.
    private static func normalizedPathComponentsPath(_ value: String) -> String {
        let normalized = normalizedLocalPath(value)
        let isAbsolute = normalized.hasPrefix("/")
        var components: [String] = []

        for component in normalized.split(separator: "/", omittingEmptySubsequences: true) {
            switch component {
            case ".":
                continue
            case "..":
                if !components.isEmpty {
                    components.removeLast()
                } else if !isAbsolute {
                    components.append(String(component))
                }
            default:
                components.append(String(component))
            }
        }

        let joined = components.joined(separator: "/")
        return isAbsolute ? "/\(joined)" : joined
    }
}

enum AssistantMarkdownContentSegment: Identifiable, Equatable {
    case text(id: Int, value: String)
    case image(AssistantMarkdownImageReference)

    var id: String {
        switch self {
        case .text(let id, _):
            return "text-\(id)"
        case .image(let reference):
            return reference.id
        }
    }
}

enum AssistantMarkdownImageReferenceParser {
    nonisolated private static let markdownImageRegex = try? NSRegularExpression(pattern: #"!\[([^\]]*)\]\(([^)]+)\)"#)

    nonisolated static func references(in text: String) -> [AssistantMarkdownImageReference] {
        var references: [AssistantMarkdownImageReference] = []
        var isInsideFence = false
        var occurrenceIndex = 0

        for line in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if isFenceDelimiter(line) {
                isInsideFence.toggle()
                continue
            }
            guard !isInsideFence else {
                continue
            }

            references.append(contentsOf: validImageMatches(in: line).map { match in
                defer { occurrenceIndex += 1 }
                return AssistantMarkdownImageReference(
                    path: match.path,
                    altText: match.altText,
                    occurrenceIndex: occurrenceIndex
                )
            })
        }

        return references
    }

    nonisolated static func visibleTextRemovingImageSyntax(from text: String) -> String {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var isInsideFence = false
        let transformedLines = lines.compactMap { line -> String? in
            if isFenceDelimiter(line) {
                isInsideFence.toggle()
                return line
            }
            guard !isInsideFence else {
                return line
            }

            let matches = validImageMatches(in: line)
            guard !matches.isEmpty else {
                return line
            }

            let lineWithoutImageSyntax = NSMutableString(string: line)
            for match in matches.reversed() {
                lineWithoutImageSyntax.replaceCharacters(in: match.range, with: "")
            }
            if String(lineWithoutImageSyntax).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return nil
            }

            let transformedLine = NSMutableString(string: line)
            for match in matches.reversed() {
                let replacement = replacementText(for: match)
                transformedLine.replaceCharacters(in: match.range, with: replacement)
            }

            let nextLine = String(transformedLine)
            return nextLine.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? nil
                : nextLine
        }

        return transformedLines.joined(separator: "\n")
    }

    // Keeps temporary screenshots in their authored markdown position while generated images remain trailing previews.
    static func contentSegmentsPreservingTemporaryImages(from text: String) -> [AssistantMarkdownContentSegment] {
        var segments: [AssistantMarkdownContentSegment] = []
        var isInsideFence = false
        var occurrenceIndex = 0
        var textSegmentID = 0
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)

        func appendText(_ value: String) {
            guard !value.isEmpty else { return }
            if case .text(let id, let existing)? = segments.last {
                segments[segments.count - 1] = .text(id: id, value: existing + value)
            } else {
                segments.append(.text(id: textSegmentID, value: value))
                textSegmentID += 1
            }
        }

        for (lineIndex, line) in lines.enumerated() {
            let lineSuffix = lineIndex < lines.count - 1 ? "\n" : ""
            if isFenceDelimiter(line) {
                appendText(line + lineSuffix)
                isInsideFence.toggle()
                continue
            }
            guard !isInsideFence else {
                appendText(line + lineSuffix)
                continue
            }

            let matches = validImageMatches(in: line)
            guard !matches.isEmpty else {
                appendText(line + lineSuffix)
                continue
            }

            let nsLine = line as NSString
            var cursor = 0
            for match in matches {
                if match.range.location > cursor {
                    appendText(nsLine.substring(with: NSRange(location: cursor, length: match.range.location - cursor)))
                }

                let reference = AssistantMarkdownImageReference(
                    path: match.path,
                    altText: match.altText,
                    occurrenceIndex: occurrenceIndex
                )
                occurrenceIndex += 1
                if reference.isTemporaryScreenshotImage {
                    segments.append(.image(reference))
                }

                cursor = match.range.location + match.range.length
            }
            if cursor < nsLine.length {
                appendText(nsLine.substring(from: cursor))
            }
            appendText(lineSuffix)
        }

        return segments.filter { segment in
            if case .text(_, let value) = segment {
                return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            return true
        }
    }

    static func isTemporaryScreenshotImagePath(_ path: String) -> Bool {
        let normalized = path.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\", with: "/")
            .lowercased()
        return normalized.hasPrefix("/tmp/")
            || normalized.hasPrefix("/private/tmp/")
            || (normalized.hasPrefix("/private/var/folders/") && normalized.contains("/t/"))
    }

    nonisolated static func isCodexGeneratedImagePath(_ path: String) -> Bool {
        path.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\", with: "/")
            .lowercased()
            .contains("/.codex/generated_images/")
    }

    nonisolated private static func markdownImageMatches(in text: String) -> [(range: NSRange, altText: String, path: String)] {
        guard let regex = markdownImageRegex else {
            return []
        }

        let nsText = text as NSString
        let protectedRanges = TurnMessageRegexCache.inlineCodeRanges(in: text)
        return regex.matches(in: text, range: NSRange(location: 0, length: nsText.length)).compactMap { match in
            guard !TurnMessageRegexCache.rangeOverlaps(match.range, protectedRanges: protectedRanges) else {
                return nil
            }
            guard match.numberOfRanges > 2 else { return nil }
            let alt = nsText.substring(with: match.range(at: 1))
            let path = nsText.substring(with: match.range(at: 2))
            return (match.range, alt, normalizedImagePath(path))
        }
    }

    nonisolated private static func validImageMatches(in text: String) -> [(range: NSRange, altText: String, path: String)] {
        markdownImageMatches(in: text).filter { match in
            CommandOutputImageReferenceParser.isImagePath(match.path)
        }
    }

    nonisolated private static func isFenceDelimiter(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("`@agnt``")
    }

    nonisolated private static func normalizedImagePath(_ raw: String) -> String {
        var candidate = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "\"'`<>"))

        if candidate.hasPrefix("file://") {
            candidate = String(candidate.dropFirst("file://".count))
        }
        return candidate.removingPercentEncoding ?? candidate
    }

    nonisolated private static func replacementText(for match: (range: NSRange, altText: String, path: String)) -> String {
        let trimmedAlt = match.altText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedAlt.isEmpty {
            return trimmedAlt
        }

        let basename = (match.path as NSString).lastPathComponent
        return basename.isEmpty ? "Image" : basename
    }
}
