// FILE: MessageRowAuxiliaryViews.swift
// Purpose: Sheet, status-card, and preview helpers used by MessageRow.
// Layer: View Components

import SwiftUI

struct SelectableMessageTextSheetState: Identifiable {
    let id = UUID()
    let role: CodexMessageRole
    let text: String
    let usesMarkdownSelection: Bool

    var title: String {
        switch role {
        case .assistant:
            return "Assistant Message"
        case .system:
            return "System Message"
        case .user:
            return "Message"
        }
    }
}

struct SelectableMessageTextSheet: View {
    let state: SelectableMessageTextSheetState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if state.usesMarkdownSelection {
                        MarkdownTextView(
                            text: state.text,
                            profile: .assistantProse,
                            enablesSelection: true
                        )
                    } else {
                        Text(state.text)
                            .font(AppFont.body())
                            .foregroundStyle(.primary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(16)
            }
            .navigationTitle(state.title)
            .navigationBarTitleDisplayMode(.inline)
            .adaptiveNavigationBar()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

struct CommandExecutionStatusCard: View {
    let status: CommandExecutionStatusModel
    let itemId: String?
    @Environment(CodexService.self) private var codex
    @State private var isShowingDetailSheet = false
    @State private var isLoadingImagePreview = false
    @State private var imagePreviewError: String?
    @State private var previewImage: PreviewImagePayload?
    @State private var unavailableImagePreviewPaths: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            CommandExecutionCardBody(
                command: status.command,
                statusLabel: status.statusLabel,
                accent: status.accent
            )
                .contentShape(Rectangle())
                .onTapGesture {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    isShowingDetailSheet = true
                }

            if let imageReference {
                commandImagePreviewButton(for: imageReference)
            }
        }
            .sheet(isPresented: $isShowingDetailSheet) {
                CommandExecutionDetailSheet(status: status, details: detailModel)
                    .presentationDetents([.fraction(0.35), .medium])
            }
            .fullScreenCover(item: $previewImage) { payload in
                ZoomableImagePreviewScreen(
                    payload: payload,
                    onDismiss: { previewImage = nil }
                )
            }
            .alert("Image Preview", isPresented: imagePreviewErrorIsPresented, actions: {
                Button("OK", role: .cancel) {
                    imagePreviewError = nil
                }
            }, message: {
                Text(imagePreviewError ?? "")
            })
    }

    private var detailModel: CommandExecutionDetails? {
        guard let itemId else { return nil }
        return codex.commandExecutionDetailsByItemID[itemId]
    }

    private var imageReference: CommandOutputImageReference? {
        guard let details = detailModel else {
            return nil
        }
        guard let reference = CommandOutputImageReferenceParser.firstReference(
            command: details.fullCommand,
            outputTail: details.outputTail,
            cwd: details.cwd
        ) else {
            return nil
        }
        return unavailableImagePreviewPaths.contains(reference.path) ? nil : reference
    }

    private func commandImagePreviewButton(for reference: CommandOutputImageReference) -> some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            loadImagePreview(reference)
        } label: {
            HStack(spacing: 8) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color(.secondarySystemFill))
                    if isLoadingImagePreview {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "photo")
                            .font(AppFont.system(size: 14, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: 32, height: 32)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Image")
                        .font(AppFont.caption(weight: .medium))
                        .foregroundStyle(.secondary)
                    Text(reference.fileName)
                        .font(AppFont.mono(.caption))
                        .foregroundStyle(.primary.opacity(0.78))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(AppFont.system(size: 8, weight: .semibold))
                    .foregroundStyle(.quaternary)
            }
            .padding(8)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(.secondarySystemBackground).opacity(0.55))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color(.separator).opacity(0.55), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(isLoadingImagePreview)
    }

    private func loadImagePreview(_ reference: CommandOutputImageReference) {
        guard !isLoadingImagePreview else { return }
        isLoadingImagePreview = true

        Task { @MainActor in
            defer { isLoadingImagePreview = false }
            do {
                let cachedPreview = await WorkspaceImagePreviewCache.shared.cachedPreview(forPath: reference.path)
                let result = try await codex.readWorkspaceImage(
                    path: reference.path,
                    cwd: detailModel?.cwd,
                    cachedMetadata: cachedPreview?.metadata
                )
                if result.isNotModified, let cachedPreview {
                    previewImage = PreviewImagePayload(
                        image: cachedPreview.payload.image,
                        title: cachedPreview.metadata.fileName.isEmpty ? reference.fileName : cachedPreview.metadata.fileName
                    )
                    return
                }

                let decodedImage = try await WorkspaceImagePreviewCache.shared.preview(for: result)
                previewImage = PreviewImagePayload(
                    image: decodedImage.image,
                    title: result.fileName.isEmpty ? reference.fileName : result.fileName
                )
            } catch {
                if Self.isMissingWorkspaceImageError(error) {
                    unavailableImagePreviewPaths.insert(reference.path)
                    return
                }
                imagePreviewError = error.localizedDescription
            }
        }
    }

    // Stale temp image previews are expected after streaming; hide the ghost row instead of interrupting the user.
    private static func isMissingWorkspaceImageError(_ error: Error) -> Bool {
        if case CodexServiceError.rpcError(let rpcError) = error {
            return rpcError.message.localizedCaseInsensitiveContains("image file no longer exists")
                || rpcError.message.localizedCaseInsensitiveContains("no longer exists")
        }
        return error.localizedDescription.localizedCaseInsensitiveContains("image file no longer exists")
    }

    private var imagePreviewErrorIsPresented: Binding<Bool> {
        Binding(
            get: { imagePreviewError != nil },
            set: { isPresented in
                if !isPresented {
                    imagePreviewError = nil
                }
            }
        )
    }
}

/// Compact `+N -M` label in green/red. Caller applies `.font()`.
struct DiffCountsLabel: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 4) {
            Text("+\(additions)")
                .foregroundStyle(Color.green)
            Text("-\(deletions)")
                .foregroundStyle(Color.red)
        }
    }
}

struct ApprovalBanner: View {
    let request: CodexApprovalRequest
    let isLoading: Bool
    let onApprove: () -> Void
    let onDecline: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Approval request", systemImage: "checkmark.shield")
                .font(AppFont.subheadline())

            if let command = request.command, !command.isEmpty {
                Text(command)
                    .font(AppFont.mono(.callout))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            } else if let reason = request.reason, !reason.isEmpty {
                Text(reason)
                    .font(AppFont.callout())
            } else {
                Text(request.method)
                    .font(AppFont.callout())
            }

            HStack {
                Button("Approve", action: {
                    HapticFeedback.shared.triggerImpactFeedback()
                    onApprove()
                })
                    .buttonStyle(.borderedProminent)

                Button("Deny", role: .destructive, action: {
                    HapticFeedback.shared.triggerImpactFeedback()
                    onDecline()
                })
                    .buttonStyle(.bordered)
            }
            .disabled(isLoading)
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct TimelineSystemBlockPreviewSurface<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .background(Color(.systemBackground))
    }
}

@MainActor
struct ToolCallSystemBlockPreviewHost: View {
    var body: some View {
        TimelineSystemBlockPreviewSurface {
            CommandExecutionStatusCard(
                status: CommandExecutionStatusModel(
                    command: "npm run lint -- --fix",
                    statusLabel: "completed",
                    accent: .completed
                ),
                itemId: "preview-tool-call"
            )
        }
        .environment(CodexService())
    }
}

enum AssistantTurnEndActionVisibility {
    // Ties Diff/Revert to the block's own streaming state so interrupted and
    // turn-less recovered rows keep their end-of-turn controls once settled.
    static func shouldShow(accessoryState: AssistantBlockAccessoryState?) -> Bool {
        guard let accessoryState, !accessoryState.showsRunningIndicator else { return false }
        return accessoryState.blockRevertPresentation != nil
            || accessoryState.blockDiffEntries != nil
    }
}

#Preview("Tool Call Block") {
    ToolCallSystemBlockPreviewHost()
}
