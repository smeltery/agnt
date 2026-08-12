// FILE: ComposerBottomBar.swift
// Purpose: Bottom bar with attachment/runtime/access menus, queue controls, and send button.
// Layer: View Component
// Exports: ComposerBottomBar
// Depends on: SwiftUI, UIKit, TurnComposerMetaMapper

import SwiftUI
import UIKit

struct ComposerBottomBar: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var showsAllModelsSheet = false
    @AppStorage(UserBubbleColor.storageKey) private var userBubbleColorRawValue = UserBubbleColor.defaultStoredRawValue

    // Data
    let orderedModelOptions: [CodexModelOption]
    let selectedModelID: String?
    let selectedModelTitle: String
    let isLoadingModels: Bool
    let isRuntimeSelectionLoading: Bool
    let runtimeState: TurnComposerRuntimeState
    let runtimeActions: TurnComposerRuntimeActions
    // Re-requests model/list when the runtime picker opens without options
    // (bootstrap fetch failed or still in flight). Defaulted for previews.
    var onRefreshModelsIfNeeded: () -> Void = {}
    let remainingAttachmentSlots: Int
    let isComposerInteractionLocked: Bool
    let isSendDisabled: Bool
    let isSending: Bool
    let isPlanModeArmed: Bool
    let queuedCount: Int
    let isQueuePaused: Bool
    let activeTurnID: String?
    let isThreadRunning: Bool
    var showsSendButton: Bool = true
    let voiceButtonPresentation: TurnComposerVoiceButtonPresentation
    let selectedAccessMode: CodexAccessMode
    let contextWindowUsage: ContextWindowUsage?
    let rateLimitBuckets: [CodexRateLimitBucket]
    let isLoadingRateLimits: Bool
    let rateLimitsErrorMessage: String?
    let shouldAutoRefreshUsageStatus: Bool
    let onRefreshUsageStatus: () async -> Void
    let onSelectAccessMode: (CodexAccessMode) -> Void
    let onTapAddImage: () -> Void
    let onTapTakePhoto: () -> Void
    let onTapVoice: () -> Void
    let onSetPlanModeArmed: (Bool) -> Void
    let onResumeQueue: () -> Void
    let onStopTurn: (String?) -> Void
    let onSend: () -> Void

    // MARK: - Constants

    private let metaLabelColor = Color(.secondaryLabel)
    private var metaTextFont: Font { AppFont.subheadline() }
    private var metaSymbolFont: Font { AppFont.system(size: 11, weight: .regular) }
    private let metaVerticalPadding: CGFloat = 6
    private let plusTapTargetSide: CGFloat = 22

    private var showsStopButton: Bool {
        isThreadRunning && !showsSendButton
    }

    private var sendButtonIconColor: Color {
        if isSendDisabled { return Color(.systemGray2) }
        return selectedUserBubbleColor.ctaPalette.foreground
    }

    private var sendButtonBackgroundColor: Color {
        if isSendDisabled { return Color(.systemGray5) }
        return selectedUserBubbleColor.ctaPalette.background
    }

    private var selectedUserBubbleColor: UserBubbleColor {
        UserBubbleColor(rawValue: userBubbleColorRawValue) ?? .default
    }

    // MARK: - Body

    var body: some View {
        HStack(spacing: 8) {
            ComposerAttachmentMenu(
                isPlanModeArmed: isPlanModeArmed,
                runtimeState: runtimeState,
                runtimeActions: runtimeActions,
                remainingAttachmentSlots: remainingAttachmentSlots,
                isInteractionLocked: isComposerInteractionLocked,
                onSetPlanModeArmed: onSetPlanModeArmed,
                onTapAddImage: onTapAddImage,
                onTapTakePhoto: onTapTakePhoto
            )
            ComposerAccessModeControl(
                selectedAccessMode: selectedAccessMode,
                isInteractionLocked: isComposerInteractionLocked,
                onSelect: onSelectAccessMode
            )
            inlineStatusControl

            ComposerRuntimeMenuControl(
                orderedModelOptions: orderedModelOptions,
                selectedModelID: selectedModelID,
                selectedModelTitle: selectedModelTitle,
                isLoadingModels: isLoadingModels,
                isRuntimeSelectionLoading: isRuntimeSelectionLoading,
                runtimeState: runtimeState,
                runtimeActions: runtimeActions,
                showsAllModelsSheet: $showsAllModelsSheet,
                onRefreshModelsIfNeeded: onRefreshModelsIfNeeded
            )
            .equatable()
            if isPlanModeArmed {
                Divider()
                    .frame(height: 16)
                planModeIndicator
            }
            Spacer(minLength: 0)

            if isQueuePaused && queuedCount > 0 {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    onResumeQueue()
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(AppFont.system(size: 12, weight: .bold))
                        .foregroundStyle(Color(.systemBackground))
                        .frame(width: 28, height: 28)
                        .background(Color(.systemGray2), in: Circle())
                }
                .accessibilityLabel("Resume queued messages")
            }

            ComposerVoiceButton(
                presentation: voiceButtonPresentation,
                onTap: onTapVoice
            )

            if showsStopButton {
                ComposerStopControl(
                    activeTurnID: activeTurnID,
                    isSending: isSending,
                    onStopTurn: onStopTurn
                )
            }

            if showsSendButton {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback()
                    onSend()
                } label: {
                    Image(systemName: "arrow.up")
                        .font(AppFont.system(size: 12, weight: .bold))
                        .foregroundStyle(sendButtonIconColor)
                        .frame(width: 32, height: 32)
                        .background(sendButtonBackgroundColor, in: Circle())
                }
                .overlay(alignment: .topTrailing) {
                    if queuedCount > 0 {
                        queueBadge
                            .offset(x: 8, y: -8)
                    }
                }
                .disabled(isSendDisabled)
            }
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 4)
        .padding(.top, 2)
        .sheet(isPresented: $showsAllModelsSheet) {
            AllModelsSheet(
                models: orderedModelOptions,
                selectedModelID: selectedModelID,
                isLoadingModels: isLoadingModels,
                modelSupportsFastMode: modelSupportsFastMode,
                onSelect: { modelID in
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    runtimeActions.selectModel(modelID)
                    showsAllModelsSheet = false
                }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    // MARK: - Menus

    private var inlineStatusControl: some View {
        ContextWindowProgressRing(
            usage: contextWindowUsage,
            rateLimitBuckets: rateLimitBuckets,
            isLoadingRateLimits: isLoadingRateLimits,
            rateLimitsErrorMessage: rateLimitsErrorMessage,
            shouldAutoRefreshStatus: shouldAutoRefreshUsageStatus,
            onRefreshStatus: onRefreshUsageStatus
        )
    }

    private var planModeIndicator: some View {
        HStack(spacing: 5) {
            Image(systemName: "checklist")
                .font(metaSymbolFont)
            Text("Plan")
                .font(metaTextFont)
                .fontWeight(.regular)
                .lineLimit(1)
        }
        .padding(.vertical, metaVerticalPadding)
        .padding(.horizontal, 4)
        .foregroundStyle(Color(.plan))
    }

    // Toggling Fast Mode from the plus menu mirrors the runtime speed menu without adding another visible pill.
    private func toggleFastMode() {
        runtimeActions.selectServiceTier(runtimeState.isSelectedServiceTier(.fast) ? nil : .fast)
    }

    private var fastModePlusMenuIconName: String {
        runtimeState.isSelectedServiceTier(.fast) ? "bolt.fill" : "bolt"
    }

    // Mirrors the bridge-provided runtime capability instead of guessing from the model name.
    private func modelSupportsFastMode(_ model: CodexModelOption) -> Bool {
        return model.supportsServiceTier(.fast)
    }

    private var queueBadge: some View {
        HStack(spacing: 3) {
            if isQueuePaused {
                Image(systemName: "pause.fill")
                    .font(AppFont.system(size: 8, weight: .bold))
            }
            Text("\(queuedCount)")
                .font(AppFont.caption2(weight: .bold))
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(
            Capsule().fill(isQueuePaused ? Color(.systemGray3) : Color(.systemGray4))
        )
    }
}

// Keeps the mic button state and styling decisions outside the layout code.
struct TurnComposerVoiceButtonPresentation {
    let systemImageName: String
    let foregroundColor: Color
    let backgroundColor: Color
    let accessibilityLabel: String
    let isDisabled: Bool
    let showsProgress: Bool
    let hasCircleBackground: Bool
}

struct ComposerAttachmentMenu: View {
    let isPlanModeArmed: Bool
    let runtimeState: TurnComposerRuntimeState
    let runtimeActions: TurnComposerRuntimeActions
    let remainingAttachmentSlots: Int
    let isInteractionLocked: Bool
    let onSetPlanModeArmed: (Bool) -> Void
    let onTapAddImage: () -> Void
    let onTapTakePhoto: () -> Void
    var tapTargetSide: CGFloat = 22

    private let metaLabelColor = Color(.secondaryLabel)

    var body: some View {
        UIKitMenuButton {
            Image(systemName: "plus")
                .font(AppFont.subheadline())
                .fontWeight(.regular)
                .foregroundStyle(metaLabelColor)
                .frame(width: tapTargetSide, height: tapTargetSide)
                .contentShape(Circle())
        } menu: {
            attachmentMenu()
        }
        .tint(metaLabelColor)
        .disabled(isInteractionLocked)
        .accessibilityLabel("Composer options")
    }

    private func attachmentMenu() -> UIMenu {
        var modeActions: [UIMenuElement] = [
            UIAction(
                title: "Plan mode",
                image: UIImage(systemName: "checklist"),
                state: isPlanModeArmed ? .on : .off
            ) { _ in
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                onSetPlanModeArmed(!isPlanModeArmed)
            },
        ]

        if runtimeState.supportsFastMode {
            modeActions.append(
                UIAction(
                    title: "Fast Mode",
                    image: UIImage(systemName: runtimeState.isSelectedServiceTier(.fast) ? "bolt.fill" : "bolt"),
                    state: runtimeState.isSelectedServiceTier(.fast) ? .on : .off
                ) { _ in
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    runtimeActions.selectServiceTier(runtimeState.isSelectedServiceTier(.fast) ? nil : .fast)
                }
            )
        }

        let attachmentActions: [UIMenuElement] = [
            UIAction(
                title: "Photo library",
                image: UIImage(systemName: "photo"),
                attributes: remainingAttachmentSlots == 0 ? .disabled : []
            ) { _ in
                HapticFeedback.shared.triggerImpactFeedback()
                onTapAddImage()
            },
            UIAction(
                title: "Take a photo",
                image: UIImage(systemName: "camera.fill"),
                attributes: remainingAttachmentSlots == 0 ? .disabled : []
            ) { _ in
                HapticFeedback.shared.triggerImpactFeedback()
                onTapTakePhoto()
            },
        ]

        return UIMenu(children: [
            UIMenu(options: [.displayInline], children: modeActions),
            UIMenu(options: [.displayInline], children: attachmentActions),
        ])
    }
}

struct ComposerVoiceButton: View {
    let presentation: TurnComposerVoiceButtonPresentation
    let onTap: () -> Void
    var tapTargetSide: CGFloat = 32

    var body: some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback()
            onTap()
        } label: {
            label
        }
        .disabled(presentation.isDisabled)
        .accessibilityLabel(presentation.accessibilityLabel)
    }

    @ViewBuilder
    private var label: some View {
        if presentation.showsProgress {
            ProgressView()
                .tint(presentation.foregroundColor)
                .frame(width: tapTargetSide, height: tapTargetSide)
                .background(presentation.backgroundColor, in: Circle())
        } else if presentation.hasCircleBackground {
            Image(systemName: presentation.systemImageName)
                .font(AppFont.system(size: 12, weight: .bold))
                .foregroundStyle(presentation.foregroundColor)
                .frame(width: tapTargetSide, height: tapTargetSide)
                .background(presentation.backgroundColor, in: Circle())
        } else {
            Image(systemName: presentation.systemImageName)
                .font(AppFont.subheadline())
                .foregroundStyle(presentation.foregroundColor)
                .frame(width: tapTargetSide, height: tapTargetSide)
                .contentShape(Circle())
        }
    }
}

struct ComposerStopControl: View {
    let activeTurnID: String?
    let isSending: Bool
    let onStopTurn: (String?) -> Void
    var diameter: CGFloat = 32
    var iconSize: CGFloat = 12

    var body: some View {
        Group {
            if isSending && activeTurnID == nil {
                ProgressView()
                    .tint(Color(.label))
                    .frame(width: diameter, height: diameter)
                    .accessibilityLabel("Starting run")
            } else {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback()
                    onStopTurn(activeTurnID)
                } label: {
                    Image(systemName: "stop.fill")
                        .font(AppFont.system(size: iconSize, weight: .bold))
                        .foregroundStyle(Color(.systemBackground))
                        .frame(width: diameter, height: diameter)
                        .background(Color(.label), in: Circle())
                }
                .accessibilityLabel("Stop current run")
            }
        }
    }
}
