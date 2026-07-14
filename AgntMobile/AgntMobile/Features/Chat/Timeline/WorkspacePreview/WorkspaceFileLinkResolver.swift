// FILE: WorkspaceFileLinkResolver.swift
// Purpose: Resolves local workspace file links and preview preferences.
// Layer: View Support
// Exports: WorkspaceFilePreviewRequest, WorkspaceFileLinkResolver
// Depends on: Foundation

import Foundation

struct WorkspaceFilePreviewRequest: Identifiable, Equatable {
    let path: String
    let currentWorkingDirectory: String?

    var id: String {
        "\(currentWorkingDirectory ?? "")|\(path)"
    }
}

enum WorkspaceLinkedFilePreviewKind {
    case imageFirst
    case textFirst
    case svg
}

enum WorkspaceFileLinkResolver {
    private static let textFileExtensions: Set<String> = [
        "c", "cc", "cpp", "css", "go", "h", "html", "java", "js", "json", "jsx",
        "kt", "m", "md", "mm", "py", "rb", "rs", "sh", "swift", "toml", "ts",
        "tsx", "txt", "xml", "yaml", "yml"
    ]
    private static let imageFileExtensions: Set<String> = [
        "gif", "heic", "heif", "jpeg", "jpg", "png", "webp"
    ]
    // SVG is text on disk but previews best as rendered artwork, so it gets its own kind.
    private static let svgFileExtension = "svg"
    private static let extensionlessFileNames: Set<String> = [
        "dockerfile", "gemfile", "makefile", "podfile"
    ]

    static func localPath(from url: URL) -> String? {
        if url.isFileURL {
            return normalizedPath(url.path)
        }

        guard url.scheme == nil else {
            return nil
        }

        let rawValue = url.absoluteString.removingPercentEncoding ?? url.absoluteString
        return normalizedPath(rawValue)
    }

    static func preferredPreviewKind(for path: String) -> WorkspaceLinkedFilePreviewKind {
        let fileExtension = (path as NSString).pathExtension.lowercased()
        if fileExtension == svgFileExtension {
            return .svg
        }
        return textFileExtensions.contains(fileExtension) ? .textFirst : .imageFirst
    }

    private static func normalizedPath(_ value: String) -> String? {
        let trimmed = stripLineSuffix(from: stripFragmentAndQuery(from: value))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              !trimmed.hasPrefix("#"),
              !trimmed.contains("\n"),
              !trimmed.contains("\r") else {
            return nil
        }
        guard isLocalPathCandidate(trimmed) else {
            return nil
        }
        return trimmed
    }

    private static func isLocalPathCandidate(_ value: String) -> Bool {
        if value.hasPrefix("/") || value.hasPrefix("./") || value.hasPrefix("../") {
            return true
        }
        guard !looksLikeSchemeLessWebURL(value) else {
            return false
        }

        let fileName = (value as NSString).lastPathComponent.lowercased()
        let fileExtension = (value as NSString).pathExtension.lowercased()
        return extensionlessFileNames.contains(fileName)
            || textFileExtensions.contains(fileExtension)
            || imageFileExtensions.contains(fileExtension)
            || fileExtension == svgFileExtension
    }

    private static func looksLikeSchemeLessWebURL(_ value: String) -> Bool {
        guard value.contains("/") else {
            return false
        }
        guard let firstComponent = value.split(separator: "/", maxSplits: 1).first else {
            return false
        }
        return firstComponent.contains(".")
            && !firstComponent.hasPrefix(".")
            && !firstComponent.hasSuffix(".")
    }

    private static func stripFragmentAndQuery(from value: String) -> String {
        guard let boundary = value.firstIndex(where: { $0 == "#" || $0 == "?" }) else {
            return value
        }
        return String(value[..<boundary])
    }

    private static func stripLineSuffix(from value: String) -> String {
        var normalized = value
        if let range = normalized.range(of: #":\d+(?::\d+)?$"#, options: .regularExpression) {
            normalized.removeSubrange(range)
        }
        return normalized
    }
}
