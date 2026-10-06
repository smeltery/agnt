import SwiftUI
import PhotosUI

extension TurnView {
    var shouldAnchorToAssistantResponseBinding: Binding<Bool> {
        Binding(
            get: { viewModel.shouldAnchorToAssistantResponse },
            set: { viewModel.shouldAnchorToAssistantResponse = $0 }
        )
    }
    var isShowingNothingToCommitAlertBinding: Binding<Bool> {
        Binding(
            get: { viewModel.isShowingNothingToCommitAlert },
            set: { viewModel.isShowingNothingToCommitAlert = $0 }
        )
    }

    @ViewBuilder
    var gitActionToastOverlay: some View {
        if let action = viewModel.runningGitAction {
            InAppToastBannerView(
                title: viewModel.gitActionLoadingTitle ?? "Git action running",
                subtitle: nil,
                detailLines: action.loadingSteps(repoSync: viewModel.gitRepoSync),
                accessibilityHint: nil,
                isDismissable: false,
                onTap: nil,
                onDismiss: nil
            ) {
                ZStack(alignment: .bottomTrailing) {
                    Image(systemName: "icloud.and.arrow.up.fill")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(.blue)

                    ProgressView()
                        .controlSize(.mini)
                        .background(Color(.systemBackground), in: Circle())
                        .offset(x: 4, y: 4)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    var gitSyncAlertBinding: Binding<TurnGitSyncAlert?> {
        Binding(
            get: { viewModel.gitSyncAlert },
            set: { newValue in
                if let newValue {
                    viewModel.gitSyncAlert = newValue
                } else {
                    viewModel.dismissGitSyncAlert()
                }
            }
        )
    }

    var checkedOutElsewhereAlertIsPresented: Binding<Bool> {
        Binding(
            get: { checkedOutElsewhereAlert != nil },
            set: { isPresented in
                if !isPresented {
                    checkedOutElsewhereAlert = nil
                }
            }
        )
    }

    var assistantRevertSheetPresentedBinding: Binding<Bool> {
        Binding(
            get: { assistantRevertSheetState != nil },
            set: { isPresented in
                if !isPresented {
                    assistantRevertSheetState = nil
                }
            }
        )
    }
    var isPhotoPickerPresentedBinding: Binding<Bool> {
        Binding(
            get: { viewModel.isPhotoPickerPresented },
            set: { viewModel.isPhotoPickerPresented = $0 }
        )
    }

    var isCameraPresentedBinding: Binding<Bool> {
        Binding(
            get: { viewModel.isCameraPresented },
            set: { viewModel.isCameraPresented = $0 }
        )
    }

    var photoPickerItemsBinding: Binding<[PhotosPickerItem]> {
        Binding(
            get: { viewModel.photoPickerItems },
            set: { viewModel.photoPickerItems = $0 }
        )
    }

    // MARK: - Derived UI state

    var orderedModelOptions: [CodexModelOption] {
        TurnComposerMetaMapper.orderedModels(from: codex.availableModels)
    }

    var reasoningDisplayOptions: [TurnComposerReasoningDisplayOption] {
        TurnComposerMetaMapper.reasoningDisplayOptions(
            from: codex.supportedReasoningEffortsForSelectedModel(threadId: codex.activeThreadId).map(\.reasoningEffort)
        )
    }

    var selectedModelTitle: String {
        if let selectedModel = codex.selectedModelOption(threadId: codex.activeThreadId) {
            return TurnComposerMetaMapper.modelTitle(for: selectedModel)
        }

        return TurnComposerMetaMapper.modelTitle(forIdentifier: codex.selectedModelId)
    }

    var approvalForThread: CodexApprovalRequest? {
        codex.pendingApproval(for: thread.id)
    }

    var approvalRequestChangeToken: String? {
        guard let request = approvalForThread else {
            return nil
        }

        let reason = request.reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let command = request.command?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return [request.id, reason, command].joined(separator: "|")
    }

    func syncApprovalAlertPresentation() {
        alertApprovalRequest = approvalForThread
        isApprovalAlertPresented = alertApprovalRequest != nil
    }

    func restoreApprovalAlert(afterFailureOf request: CodexApprovalRequest) {
        alertApprovalRequest = approvalForThread ?? request
        isApprovalAlertPresented = alertApprovalRequest != nil
    }
}
