// FILE: WorkspaceLinkedFilePreview.swift
// Purpose: Resolves and renders linked workspace file previews from timeline messages.
// Layer: View Support
// Exports: WorkspaceFilePreviewRequest, WorkspaceFileLinkResolver, WorkspaceLinkedFilePreviewScreen
// Depends on: SwiftUI, UIKit, CodexService, WorkspaceSVGWebView, WorkspaceRunestoneCodeFileView

import SwiftUI
import UIKit

struct WorkspaceFilePreviewRequest: Identifiable, Equatable {
    let path: String
    let currentWorkingDirectory: String?

    var id: String {
        "\(currentWorkingDirectory ?? "")|\(path)"
    }
}

private enum WorkspaceLinkedFilePreviewKind {
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

    fileprivate static func preferredPreviewKind(for path: String) -> WorkspaceLinkedFilePreviewKind {
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

private struct WorkspacePreviewChromeButton: View {
    let systemName: String
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            action()
        } label: {
            Image(systemName: systemName)
                .font(AppFont.system(size: 17, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 38, height: 38)
                .adaptiveGlass(.regular, in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}

private struct WorkspacePreviewTitlePill: View {
    let title: String

    var body: some View {
        Text(title)
            .font(AppFont.subheadline(weight: .semibold))
            .foregroundStyle(.primary)
            .lineLimit(1)
            .padding(.horizontal, 14)
            .frame(height: 38)
            .adaptiveGlass(.regular, in: Capsule())
    }
}

private struct WorkspacePreviewRetryButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("Retry", systemImage: "arrow.clockwise")
                .font(AppFont.subheadline(weight: .semibold))
                .padding(.horizontal, 16)
                .frame(height: 40)
                .adaptiveGlass(.regular, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

private struct WorkspaceSVGFilePreviewPayload: Equatable {
    let source: String
    let title: String
    let path: String
}

private enum WorkspaceLinkedFilePreviewPayload {
    case image(PreviewImagePayload)
    case text(WorkspaceTextFileReadResult)
    case svg(WorkspaceSVGFilePreviewPayload)
}

struct WorkspaceLinkedFilePreviewScreen: View {
    let request: WorkspaceFilePreviewRequest
    let onDismiss: () -> Void

    @Environment(CodexService.self) private var codex
    @State private var isLoading = false
    @State private var payload: WorkspaceLinkedFilePreviewPayload?
    @State private var errorMessage: String?

    var body: some View {
        Group {
            switch payload {
            case .image(let imagePayload):
                ZoomableImagePreviewScreen(payload: imagePayload, onDismiss: onDismiss)
            case .text(let file):
                WorkspaceTextFileViewerScreen(file: file, onDismiss: onDismiss, onReload: {
                    Task { await loadPreview(force: true) }
                })
            case .svg(let svgPayload):
                WorkspaceSVGFilePreviewScreen(payload: svgPayload, onDismiss: onDismiss, onReload: {
                    Task { await loadPreview(force: true) }
                })
            case nil:
                loadingOrErrorScreen
            }
        }
        .task(id: request.id) {
            await loadPreview()
        }
    }

    private var loadingOrErrorScreen: some View {
        ZStack(alignment: .top) {
            Color(.systemBackground)
                .ignoresSafeArea()

            VStack(spacing: 16) {
                Spacer(minLength: 0)

                if isLoading || errorMessage == nil {
                    ProgressView()
                        .controlSize(.large)
                    Text("Loading file")
                        .font(AppFont.subheadline(weight: .semibold))
                } else {
                    Image(systemName: "doc.text")
                        .font(AppFont.system(size: 32, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Text(fileName)
                        .font(AppFont.subheadline(weight: .semibold))
                        .multilineTextAlignment(.center)
                    if let errorMessage {
                        Text(errorMessage)
                            .font(AppFont.caption())
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .lineLimit(5)
                    }
                    WorkspacePreviewRetryButton {
                        Task { await loadPreview(force: true) }
                    }
                }

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 28)

            previewTopBar
                .padding(.horizontal, 18)
                .padding(.top, 18)
        }
    }

    private var previewTopBar: some View {
        HStack(spacing: 14) {
            WorkspacePreviewChromeButton(systemName: "xmark", accessibilityLabel: "Close file preview") {
                onDismiss()
            }

            WorkspacePreviewTitlePill(title: fileName)

            Spacer(minLength: 0)
        }
    }

    private var fileName: String {
        let basename = (request.path as NSString).lastPathComponent
        return basename.isEmpty ? "File" : basename
    }

    @MainActor
    private func loadPreview(force: Bool = false) async {
        guard !isLoading else { return }
        if payload != nil, !force {
            return
        }

        isLoading = true
        errorMessage = nil
        if force {
            payload = nil
        }
        defer { isLoading = false }

        switch WorkspaceFileLinkResolver.preferredPreviewKind(for: request.path) {
        case .imageFirst:
            await loadImageThenText(force: force)
        case .textFirst:
            await loadTextThenImage(force: force)
        case .svg:
            await loadSVGThenText()
        }
    }

    @MainActor
    private func loadSVGThenText() async {
        do {
            payload = .svg(try await loadSVGPayload())
            return
        } catch {
            // Fall back to the raw markup if the file can't be rendered as artwork.
            let svgError = error
            do {
                payload = .text(try await loadTextPayload())
            } catch {
                errorMessage = combinedPreviewError(primary: svgError, fallback: error)
            }
        }
    }

    @MainActor
    private func loadImageThenText(force: Bool) async {
        do {
            payload = .image(try await loadImagePayload(force: force))
            return
        } catch {
            let imageError = error
            do {
                payload = .text(try await loadTextPayload())
            } catch {
                errorMessage = combinedPreviewError(primary: imageError, fallback: error)
            }
        }
    }

    @MainActor
    private func loadTextThenImage(force: Bool) async {
        do {
            payload = .text(try await loadTextPayload())
            return
        } catch {
            let textError = error
            do {
                payload = .image(try await loadImagePayload(force: force))
            } catch {
                errorMessage = combinedPreviewError(primary: textError, fallback: error)
            }
        }
    }

    @MainActor
    private func loadImagePayload(force: Bool) async throws -> PreviewImagePayload {
        let imageReference = AssistantMarkdownImageReference(
            path: request.path,
            altText: fileName,
            occurrenceIndex: 0
        )
        return try await AssistantWorkspaceImagePreviewLoader.load(
            reference: imageReference,
            currentWorkingDirectory: request.currentWorkingDirectory,
            codex: codex,
            force: force
        )
    }

    @MainActor
    private func loadTextPayload() async throws -> WorkspaceTextFileReadResult {
        try await codex.readWorkspaceTextFile(
            path: request.path,
            cwd: request.currentWorkingDirectory
        )
    }

    @MainActor
    private func loadSVGPayload() async throws -> WorkspaceSVGFilePreviewPayload {
        let file = try await loadTextPayload()
        let source = file.content ?? ""
        guard !source.isEmpty else {
            throw CodexServiceError.invalidResponse("SVG preview response did not include readable SVG markup.")
        }
        return WorkspaceSVGFilePreviewPayload(source: source, title: fileName, path: request.path)
    }

    private func combinedPreviewError(primary: Error, fallback: Error) -> String {
        let primaryMessage = primary.localizedDescription
        let fallbackMessage = fallback.localizedDescription
        guard !primaryMessage.isEmpty else { return fallbackMessage }
        guard !fallbackMessage.isEmpty, fallbackMessage != primaryMessage else { return primaryMessage }
        return "\(primaryMessage)\n\(fallbackMessage)"
    }
}

private struct WorkspaceSVGFilePreviewScreen: View {
    let payload: WorkspaceSVGFilePreviewPayload
    let onDismiss: () -> Void
    let onReload: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack(alignment: .top) {
            Color(.systemBackground)
                .ignoresSafeArea()

            WorkspaceSVGWebView(source: payload.source, colorScheme: colorScheme)
                .ignoresSafeArea()

            topBar
                .padding(.horizontal, 18)
                .padding(.top, 18)
                .zIndex(2)
        }
    }

    private var topBar: some View {
        HStack(spacing: 14) {
            WorkspacePreviewChromeButton(systemName: "xmark", accessibilityLabel: "Close SVG preview") {
                onDismiss()
            }

            WorkspacePreviewTitlePill(title: payload.title.isEmpty ? "SVG" : payload.title)

            Spacer(minLength: 0)

            WorkspacePreviewChromeButton(systemName: "arrow.clockwise", accessibilityLabel: "Reload SVG preview") {
                onReload()
            }
        }
    }
}

private struct WorkspaceTextFileViewerScreen: View {
    let file: WorkspaceTextFileReadResult
    let onDismiss: () -> Void
    let onReload: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var isShowingCopiedConfirmation = false

    private var content: String {
        file.content ?? ""
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                fileMetadataHeader
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .padding(.bottom, 8)
                // Runestone provides syntax highlighting, line numbers, selection, and
                // its own scrolling, so it is not wrapped in a SwiftUI ScrollView.
                WorkspaceRunestoneCodeFileView(
                    content: content,
                    fileName: file.fileName,
                    colorScheme: colorScheme
                )
            }
            .background(Color(.systemBackground))
            .navigationTitle(file.fileName.isEmpty ? "File" : file.fileName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { onDismiss() }
                }
                ToolbarItemGroup(placement: .confirmationAction) {
                    Button {
                        onReload()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Reload file")

                    Button {
                        UIPasteboard.general.string = content
                        withAnimation(.easeInOut(duration: 0.18)) {
                            isShowingCopiedConfirmation = true
                        }
                    } label: {
                        Image(systemName: isShowingCopiedConfirmation ? "checkmark" : "doc.on.doc")
                    }
                    .accessibilityLabel("Copy file contents")
                }
            }
        }
    }

    private var fileMetadataHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(file.path)
                .font(AppFont.mono(.caption))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .truncationMode(.middle)
            Text(metadataSummary)
                .font(AppFont.caption())
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 4)
    }

    private var metadataSummary: String {
        var parts = [ByteCountFormatter.string(fromByteCount: Int64(file.byteLength), countStyle: .file)]
        if let lineCount = file.lineCount {
            parts.append("\(lineCount) line\(lineCount == 1 ? "" : "s")")
        }
        parts.append(file.encoding.uppercased())
        return parts.joined(separator: " | ")
    }
}
