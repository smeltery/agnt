// FILE: ComposerRuntimeMenuControl.swift
// Purpose: Runtime model, effort, and speed picker used by the composer bottom bar.
// Layer: View Component
// Exports: ComposerRuntimeMenuControl, AllModelsSheet
// Depends on: SwiftUI, TurnComposerMetaMapper

import SwiftUI

// Keeps the SwiftUI Menu from rebuilding during unrelated thread-sync updates.
struct ComposerRuntimeMenuControl: View, Equatable {
    let orderedModelOptions: [CodexModelOption]
    let selectedModelID: String?
    let selectedModelTitle: String
    let isLoadingModels: Bool
    let isRuntimeSelectionLoading: Bool
    let runtimeState: TurnComposerRuntimeState
    let runtimeActions: TurnComposerRuntimeActions
    @Binding var showsAllModelsSheet: Bool

    private let metaLabelColor = Color(.secondaryLabel)
    private var metaTextFont: Font { AppFont.callout() }
    private var metaSymbolFont: Font { AppFont.system(size: 11, weight: .regular) }
    private var metaChevronFont: Font { AppFont.system(size: 9, weight: .regular) }
    private let maxInlineRuntimeLabelWidth: CGFloat = 108

    static func == (lhs: ComposerRuntimeMenuControl, rhs: ComposerRuntimeMenuControl) -> Bool {
        lhs.orderedModelOptions == rhs.orderedModelOptions
            && lhs.selectedModelID == rhs.selectedModelID
            && lhs.selectedModelTitle == rhs.selectedModelTitle
            && lhs.isLoadingModels == rhs.isLoadingModels
            && lhs.isRuntimeSelectionLoading == rhs.isRuntimeSelectionLoading
            && lhs.runtimeState == rhs.runtimeState
    }

    // One consolidated runtime pill: Effort + featured models + Speed as flat sections.
    var body: some View {
        Menu {
            Section("Effort") {
                if runtimeState.reasoningDisplayOptions.isEmpty {
                    Text("No reasoning options")
                } else {
                    ForEach(runtimeState.reasoningDisplayOptions, id: \.id) { option in
                        Button {
                            HapticFeedback.shared.triggerImpactFeedback(style: .light)
                            runtimeActions.selectReasoning(option.effort)
                        } label: {
                            if runtimeState.isSelectedReasoning(option.effort) {
                                Label(option.title, systemImage: "checkmark")
                            } else {
                                Text(option.title)
                            }
                        }
                        .disabled(runtimeState.reasoningMenuDisabled)
                    }
                }
            }

            Section("Change model") {
                if isLoadingModels {
                    Text("Loading models...")
                } else if orderedModelOptions.isEmpty {
                    Text("No models available")
                } else {
                    ForEach(featuredModelOptions, id: \.id) { model in
                        Button {
                            HapticFeedback.shared.triggerImpactFeedback(style: .light)
                            runtimeActions.selectModel(model.id)
                        } label: {
                            modelMenuRow(for: model)
                        }
                    }

                    if hasNonFeaturedModels {
                        Button("Other models") {
                            HapticFeedback.shared.triggerImpactFeedback(style: .light)
                            DispatchQueue.main.async {
                                showsAllModelsSheet = true
                            }
                        }
                    }
                }
            }

            if runtimeState.supportsFastMode {
                Section("Speed") {
                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        runtimeActions.selectServiceTier(nil)
                    } label: {
                        if runtimeState.isSelectedServiceTier(nil) {
                            Label("Normal", systemImage: "checkmark")
                        } else {
                            Text("Normal")
                        }
                    }

                    ForEach(CodexServiceTier.allCases, id: \.rawValue) { tier in
                        Button {
                            HapticFeedback.shared.triggerImpactFeedback(style: .light)
                            runtimeActions.selectServiceTier(tier)
                        } label: {
                            if runtimeState.isSelectedServiceTier(tier) {
                                Label(tier.displayName, systemImage: "checkmark")
                            } else {
                                Text(tier.displayName)
                            }
                        }
                    }
                }
            }
        } label: {
            composerMenuLabel(
                title: compactRuntimeTitle,
                leadingImageName: runtimeState.showsSpeedBadgeInModelMenu ? "bolt.fill" : nil
            )
        }
        .layoutPriority(-1)
        .tint(metaLabelColor)
        .accessibilityLabel(runtimeAccessibilityLabel)
    }

    private var compactRuntimeTitle: String {
        if selectedModelID == nil {
            return isRuntimeSelectionLoading ? "Loading…" : "Select model"
        }
        if let effort = compactReasoningTitle(runtimeState.selectedReasoningTitle) {
            return "\(compactModelTitle) \(effort)"
        }
        return compactModelTitle
    }

    // Keeps inline runtime metadata short so stop + send controls do not move the composer.
    private var compactModelTitle: String {
        let normalized = selectedModelTitle
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map(String.init)

        let words = normalized.filter { word in
            let lowercased = word.lowercased()
            return lowercased != "gpt" && lowercased != "codex"
        }
        let compact = words.isEmpty ? selectedModelTitle : words.joined(separator: " ")
        return compact
    }

    private var runtimeAccessibilityLabel: String {
        if selectedModelID == nil {
            return isRuntimeSelectionLoading ? "Loading…" : "Select model"
        }
        let effort = runtimeState.selectedReasoningTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if !effort.isEmpty {
            return "\(selectedModelTitle), \(effort)"
        }
        return selectedModelTitle
    }

    private func compactReasoningTitle(_ title: String) -> String? {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != "Select reasoning" else {
            return nil
        }

        switch trimmed.lowercased() {
        case "extra high":
            return "XH"
        case "medium":
            return "Med"
        default:
            return trimmed
        }
    }

    @ViewBuilder
    private func modelMenuRow(for model: CodexModelOption) -> some View {
        HStack(spacing: 8) {
            if selectedModelID == model.id {
                Image(systemName: "checkmark")
            }
            if model.supportsServiceTier(.fast) {
                Image(systemName: CodexServiceTier.fast.iconName)
            }
            Text(TurnComposerMetaMapper.modelTitle(for: model))
        }
    }

    // The currently selected model is pinned alongside headline models.
    private var featuredModelOptions: [CodexModelOption] {
        var seenIDs = Set<String>()
        var result: [CodexModelOption] = []

        func append(_ model: CodexModelOption) {
            guard seenIDs.insert(model.id).inserted else { return }
            result.append(model)
        }

        for model in orderedModelOptions where Self.matchesFeaturedIdentifier(model) {
            append(model)
        }
        if let selected = orderedModelOptions.first(where: { $0.id == selectedModelID }) {
            append(selected)
        }
        return result
    }

    private var hasNonFeaturedModels: Bool {
        orderedModelOptions.contains { model in
            !featuredModelOptions.contains(where: { $0.id == model.id })
        }
    }

    private static let featuredModelIdentifiers: Set<String> = [
        "gpt-5.5",
        "gpt-5.4",
    ]

    private static func matchesFeaturedIdentifier(_ model: CodexModelOption) -> Bool {
        let normalizedID = model.id.lowercased()
        let normalizedModel = model.model.lowercased()
        return featuredModelIdentifiers.contains(normalizedID)
            || featuredModelIdentifiers.contains(normalizedModel)
    }

    private func composerMenuLabel(
        title: String,
        leadingImageName: String?
    ) -> some View {
        HStack(spacing: 6) {
            if let leadingImageName {
                Image(systemName: leadingImageName)
                    .font(metaSymbolFont)
            }

            Text(title)
                .font(metaTextFont)
                .fontWeight(.regular)
                .lineLimit(1)
                .truncationMode(.tail)

            Image(systemName: "chevron.down")
                .font(metaChevronFont)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 4)
        .fixedSize(horizontal: true, vertical: false)
        .foregroundStyle(metaLabelColor)
        .frame(maxWidth: maxInlineRuntimeLabelWidth, alignment: .leading)
        .clipped()
        .contentShape(Rectangle())
    }
}

// Full-list model picker shown when the user taps "See all models…" inside the
// runtime menu. Lives in a sheet so it sidesteps the SwiftUI nested-Menu bug
// while still keeping the runtime pill compact.
struct AllModelsSheet: View {
    let models: [CodexModelOption]
    let selectedModelID: String?
    let isLoadingModels: Bool
    let modelSupportsFastMode: (CodexModelOption) -> Bool
    let onSelect: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if isLoadingModels {
                    ProgressView("Loading models…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if models.isEmpty {
                    ContentUnavailableView(
                        "No models available",
                        systemImage: "square.stack.3d.up.slash",
                        description: Text("Reconnect to your local Codex bridge to refresh the model list.")
                    )
                } else {
                    List {
                        Section {
                            ForEach(models, id: \.id) { model in
                                Button {
                                    onSelect(model.id)
                                } label: {
                                    modelRow(for: model)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Choose model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private func modelRow(for model: CodexModelOption) -> some View {
        let title = TurnComposerMetaMapper.modelTitle(for: model)
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: model.id == selectedModelID ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 18))
                .foregroundStyle(model.id == selectedModelID ? Color.accentColor : Color(.tertiaryLabel))
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(title)
                        .font(AppFont.body(weight: .medium))
                        .foregroundStyle(Color(.label))
                    if modelSupportsFastMode(model) {
                        Image(systemName: CodexServiceTier.fast.iconName)
                            .font(AppFont.system(size: 11, weight: .regular))
                            .foregroundStyle(Color(.secondaryLabel))
                    }
                }
                if !model.description.isEmpty {
                    Text(model.description)
                        .font(AppFont.subheadline())
                        .foregroundStyle(Color(.secondaryLabel))
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}
