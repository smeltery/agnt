// FILE: TurnToolbarContent.swift
// Purpose: Encapsulates the TurnView navigation toolbar and thread-path sheet.
// Layer: View Component
// Exports: TurnToolbarContent, TurnThreadNavigationContext,
//          TurnThreadActionsMenuButton, TurnThreadActionMenuItem

import SwiftUI
import UIKit

struct TurnThreadNavigationContext {
    let folderName: String
    let subtitle: String
    let fullPath: String
}

struct TurnToolbarContent: ToolbarContent {
    let displayTitle: String
    let navigationContext: TurnThreadNavigationContext?
    let showsThreadActions: Bool
    let isHandingOffToMac: Bool
    let isStartingNewChat: Bool
    let canHandOffToWorktree: Bool
    let worktreeHandoffTitle: String
    let isCreatingGitWorktree: Bool
    let repoDiffTotals: GitDiffTotals?
    let isLoadingRepoDiff: Bool
    let showsGitActions: Bool
    let isGitActionEnabled: Bool
    let disabledGitActions: Set<TurnGitActionKind>
    let isRunningGitAction: Bool
    let gitActionLoadingTitle: String?
    let showsDiscardRuntimeChangesAndSync: Bool
    let gitSyncState: String?
    var onTapMacHandoff: (() -> Void)?
    var onTapWorktreeHandoff: (() -> Void)?
    var onTapNewChat: (() -> Void)?
    var onTapTerminal: (() -> Void)?
    var onTapRepoDiff: (() -> Void)?
    let onGitAction: (TurnGitActionKind) -> Void

    @Binding var isShowingPathSheet: Bool

    var body: some ToolbarContent {
        let hasTrailingCluster = repoDiffTotals != nil || showsGitActions
        let isThreadActionLoading = isHandingOffToMac || isStartingNewChat
        let canTapMacHandoff = onTapMacHandoff != nil && !isThreadActionLoading
        // Worktree handoff has its own Git/worktree gates; keep it aligned with the composer Local menu.
        let canTapWorktreeHandoff = onTapWorktreeHandoff != nil
            && canHandOffToWorktree
            && !isCreatingGitWorktree
        let canTapNewChat = onTapNewChat != nil && !isThreadActionLoading
        let canTapTerminal = onTapTerminal != nil

        ToolbarItem(placement: .principal) {
            VStack(alignment: .leading, spacing: 1) {
                Text(displayTitle)
                    .font(AppFont.headline())
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if let context = navigationContext {
                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        isShowingPathSheet = true
                    } label: {
                        Text(context.subtitle)
                            .font(AppFont.mono(.caption))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        if showsThreadActions {
            ToolbarItem(placement: .topBarTrailing) {
                TurnThreadActionsMenuButton(
                    isLoading: isThreadActionLoading,
                    actions: [
                        TurnThreadActionMenuItem(
                            title: "Continue on Desktop App",
                            icon: .system("arrow.left.arrow.right"),
                            isEnabled: canTapMacHandoff
                        ) {
                            onTapMacHandoff?()
                        },
                        TurnThreadActionMenuItem(
                            title: isCreatingGitWorktree ? "Preparing worktree..." : worktreeHandoffTitle,
                            icon: .worktree,
                            isEnabled: canTapWorktreeHandoff
                        ) {
                            onTapWorktreeHandoff?()
                        },
                        TurnThreadActionMenuItem(
                            title: "New chat",
                            icon: .system("plus.app"),
                            isEnabled: canTapNewChat
                        ) {
                            onTapNewChat?()
                        },
                        TurnThreadActionMenuItem(
                            title: "Open Terminal Here",
                            icon: .system("terminal"),
                            isEnabled: canTapTerminal
                        ) {
                            onTapTerminal?()
                        },
                    ]
                )
            }
        }

        if showsThreadActions, hasTrailingCluster {
            if #available(iOS 26.0, *) {
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
            }
        }

        if repoDiffTotals != nil || showsGitActions {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let repoDiffTotals {
                    TurnToolbarDiffTotalsLabel(
                        totals: repoDiffTotals,
                        isLoading: isLoadingRepoDiff,
                        onTap: onTapRepoDiff
                    )
                }

                if showsGitActions {
                    TurnGitActionsToolbarButton(
                        isEnabled: isGitActionEnabled,
                        disabledActions: disabledGitActions,
                        isRunningAction: isRunningGitAction,
                        loadingTitle: gitActionLoadingTitle,
                        showsDiscardRuntimeChangesAndSync: showsDiscardRuntimeChangesAndSync,
                        gitSyncState: gitSyncState,
                        onSelect: onGitAction
                    )
                }
            }
        }
    }
}

struct TurnMacHandoffToolbarLabel: View {
    let isLoading: Bool

    var body: some View {
        Group {
            if isLoading {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 24, height: 24)
            } else {
                ResizableThreadActionSymbol(systemName: "arrow.trianglehead.branch", pointSize: 14)
                    .foregroundStyle(.primary)
                    .frame(width: 24, height: 24)
            }
        }
        .contentShape(Circle())
        .adaptiveToolbarItem(in: Circle())
    }
}

struct TurnThreadActionsMenuButton: View {
    let isLoading: Bool
    var isEnabled: Bool = true
    let actions: [TurnThreadActionMenuItem]

    var body: some View {
        Group {
            if isLoading {
                TurnMacHandoffToolbarLabel(isLoading: true)
            } else {
                UIKitThreadActionsToolbarButton(
                    isEnabled: isEnabled,
                    actions: actions,
                    triggerImage: Self.triggerImage
                )
                .frame(width: Self.triggerIconSize, height: Self.triggerIconSize)
                .padding(.vertical, 4)
                .frame(minWidth: Self.minToolbarButtonSize, minHeight: Self.minToolbarButtonSize)
                .contentShape(Circle())
                .adaptiveToolbarItem(in: Circle())
            }
        }
        .opacity(isEnabled ? 1 : 0.45)
        .disabled(!isEnabled)
        .accessibilityLabel("Thread actions")
    }

    private static let triggerIconSize: CGFloat = 24
    private static let minToolbarButtonSize: CGFloat = 28

    // Keeps the toolbar trigger glyph aligned with the rest of the chrome.
    private static var triggerImage: UIImage {
        let config = UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
        return UIImage(systemName: "arrow.trianglehead.branch", withConfiguration: config) ?? UIImage()
    }
}

struct TurnThreadActionMenuItem {
    enum Icon {
        case system(String)
        case worktree

        var uiImage: UIImage? {
            switch self {
            case .system(let systemName):
                let config = UIImage.SymbolConfiguration(pointSize: 16, weight: .regular)
                return UIImage(systemName: systemName, withConfiguration: config)
            case .worktree:
                return CodexWorktreeIcon.toolbarMenuUIImage()
            }
        }
    }

    let title: String
    let icon: Icon
    var isEnabled: Bool = true
    let handler: () -> Void

    func uiAction() -> UIAction {
        let attributes: UIMenuElement.Attributes = isEnabled ? [] : .disabled
        return UIAction(
            title: title,
            image: icon.uiImage,
            attributes: attributes
        ) { _ in
            guard isEnabled else { return }
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            handler()
        }
    }
}

private struct UIKitThreadActionsToolbarButton: UIViewRepresentable {
    let isEnabled: Bool
    let actions: [TurnThreadActionMenuItem]
    let triggerImage: UIImage

    func makeCoordinator() -> Coordinator {
        Coordinator(actions: actions)
    }

    func makeUIView(context: Context) -> UIButton {
        var config = UIButton.Configuration.plain()
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0)

        let button = UIButton(configuration: config)
        button.showsMenuAsPrimaryAction = true
        button.tintColor = .label
        button.accessibilityLabel = "Thread actions"
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setContentHuggingPriority(.required, for: .vertical)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .vertical)

        let coordinator = context.coordinator
        button.menu = UIMenu(children: [
            UIDeferredMenuElement.uncached { [weak coordinator] completion in
                completion(coordinator?.makeMenu().children ?? [])
            },
        ])
        return button
    }

    func updateUIView(_ button: UIButton, context: Context) {
        var config = button.configuration ?? UIButton.Configuration.plain()
        config.image = triggerImage.withRenderingMode(.alwaysTemplate)
        button.configuration = config
        button.isEnabled = isEnabled
        button.accessibilityLabel = "Thread actions"
        context.coordinator.actions = actions
    }

    final class Coordinator {
        var actions: [TurnThreadActionMenuItem]

        init(actions: [TurnThreadActionMenuItem]) {
            self.actions = actions
        }

        // Builds fresh rows at presentation time so disabled/loading state stays current.
        func makeMenu() -> UIMenu {
            UIMenu(
                title: "",
                options: [.displayInline],
                children: actions.map { $0.uiAction() }
            )
        }
    }
}

private struct ResizableThreadActionSymbol: View {
    let systemName: String
    let pointSize: CGFloat
    var weight: UIImage.SymbolWeight = .semibold

    var body: some View {
        Image(uiImage: resizedSymbol(named: systemName, pointSize: pointSize, weight: weight))
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: pointSize, height: pointSize)
    }

    private func resizedSymbol(named name: String, pointSize: CGFloat, weight: UIImage.SymbolWeight) -> UIImage {
        let config = UIImage.SymbolConfiguration(pointSize: pointSize, weight: weight)
        guard let symbol = UIImage(systemName: name, withConfiguration: config)?
            .withRenderingMode(.alwaysTemplate) else {
            return UIImage()
        }

        let canvasSide = max(symbol.size.width, symbol.size.height)
        let canvasSize = CGSize(width: canvasSide, height: canvasSide)
        let renderer = UIGraphicsImageRenderer(size: canvasSize)
        let scale = min(canvasSize.width / symbol.size.width, canvasSize.height / symbol.size.height)
        let scaledSize = CGSize(width: symbol.size.width * scale, height: symbol.size.height * scale)
        let origin = CGPoint(
            x: (canvasSize.width - scaledSize.width) / 2,
            y: (canvasSize.height - scaledSize.height) / 2
        )

        return renderer.image { _ in
            symbol.draw(in: CGRect(origin: origin, size: scaledSize))
        }
        .withRenderingMode(.alwaysTemplate)
    }
}

private struct TurnToolbarDiffTotalsLabel: View {
    let totals: GitDiffTotals
    let isLoading: Bool
    let onTap: (() -> Void)?

    // Keeps small diff totals tappable without forcing large-count pills into a fixed width.
    private let minPillWidth: CGFloat = 50

    var body: some View {
        Group {
            if let onTap {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    onTap()
                } label: {
                    labelContent
                }
                .buttonStyle(.plain)
                .disabled(isLoading)
            } else {
                labelContent
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Repository diff total")
        .accessibilityValue(accessibilityValue)
    }

    private var labelContent: some View {
        HStack(spacing: 4) {
            if isLoading {
                ProgressView()
                    .controlSize(.mini)
            }
            Text("+\(totals.additions)")
                .foregroundStyle(Color.green)
            Text("-\(totals.deletions)")
                .foregroundStyle(Color.red)
            if totals.binaryFiles > 0 {
                Text("B\(totals.binaryFiles)")
                    .foregroundStyle(.secondary)
            }
        }
        .font(AppFont.mono(.caption))
        .frame(minWidth: minPillWidth, minHeight: 28)
        .contentShape(Capsule())
        .fixedSize(horizontal: true, vertical: false)
        .opacity(isLoading ? 0.8 : 1)
        .adaptiveToolbarItem(in: Capsule())
    }

    private var accessibilityValue: String {
        if totals.binaryFiles > 0 {
            return "+\(totals.additions) -\(totals.deletions) binary \(totals.binaryFiles)"
        }
        return "+\(totals.additions) -\(totals.deletions)"
    }
}

struct TurnThreadPathSheet: View {
    let context: TurnThreadNavigationContext
    let threadTitle: String
    var onRenameThread: ((String) -> Void)? = nil

    @State private var renamePrompt = ThreadRenamePromptState()
    @State private var didCopyPath = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if onRenameThread != nil {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Thread")
                                .font(AppFont.caption(weight: .semibold))
                                .foregroundStyle(.secondary)

                            HStack(alignment: .center, spacing: 12) {
                                Text(threadTitle)
                                    .font(AppFont.body(weight: .medium))
                                    .foregroundStyle(.primary)
                                    .lineLimit(2)
                                    .multilineTextAlignment(.leading)
                                    .frame(maxWidth: .infinity, alignment: .leading)

                                Button {
                                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                                    renamePrompt.present(currentTitle: threadTitle)
                                } label: {
                                    Image(systemName: "pencil")
                                        .font(AppFont.system(size: 14, weight: .semibold))
                                        .frame(width: 32, height: 32)
                                        .contentShape(Circle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Rename conversation")
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            Text("Path")
                                .font(AppFont.caption(weight: .semibold))
                                .foregroundStyle(.secondary)

                            Button {
                                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                                copyPathToPasteboard()
                            } label: {
                                Group {
                                    if didCopyPath {
                                        Image(systemName: "checkmark")
                                            .font(AppFont.system(size: 12, weight: .semibold))
                                    } else {
                                        Image("copy")
                                            .renderingMode(.template)
                                            .resizable()
                                            .scaledToFit()
                                            .scaleEffect(x: -1, y: 1)
                                    }
                                }
                                .frame(width: 16, height: 16)
                                .foregroundStyle(.secondary)
                                .frame(width: 32, height: 32)
                                .contentShape(Circle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(didCopyPath ? "Path copied" : "Copy path")
                        }

                        Text(context.fullPath)
                            .font(AppFont.mono(.callout))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding()
            }
            .navigationTitle(context.folderName)
            .navigationBarTitleDisplayMode(.inline)
            .adaptiveNavigationBar()
        }
        .presentationDetents([.fraction(0.4), .medium])
        .threadRenamePrompt(state: $renamePrompt) { newTitle in
            onRenameThread?(newTitle)
        }
    }

    // Copies the full local project path while keeping the sheet visible.
    private func copyPathToPasteboard() {
        UIPasteboard.general.string = context.fullPath
        withAnimation(.easeInOut(duration: 0.15)) {
            didCopyPath = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            withAnimation(.easeInOut(duration: 0.15)) {
                didCopyPath = false
            }
        }
    }
}
