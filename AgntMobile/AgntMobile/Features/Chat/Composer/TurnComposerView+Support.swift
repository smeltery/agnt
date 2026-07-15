// FILE: TurnComposerView+Support.swift
// Purpose: Accessory and autocomplete subviews for the turn composer.
// Layer: View Component support
// Exports: TurnComposerAutocompletePanels, TurnComposerAccessorySection
// Depends on: SwiftUI, composer accessory/autocomplete panels

import SwiftUI

struct TurnComposerAutocompletePanels: View {
    let state: TurnComposerAutocompleteState
    let onSelectFileAutocomplete: (CodexFuzzyFileMatch) -> Void
    let onSelectSkillAutocomplete: (CodexSkillMetadata) -> Void
    let onSelectPluginAutocomplete: (CodexPluginMetadata) -> Void
    let onSelectSlashCommand: (TurnComposerSlashCommand) -> Void
    let onSelectCodeReviewTarget: (TurnComposerReviewTarget) -> Void
    let onSelectForkDestination: (TurnComposerForkDestination) -> Void
    let onCloseSlashCommandPanel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if state.isFileAutocompleteVisible {
                FileAutocompletePanel(
                    items: state.fileAutocompleteItems,
                    pluginItems: state.pluginAutocompleteItems,
                    isLoading: state.isFileAutocompleteLoading,
                    isLoadingPlugins: state.isPluginAutocompleteLoading,
                    query: state.fileAutocompleteQuery,
                    pluginQuery: state.pluginAutocompleteQuery,
                    onSelect: onSelectFileAutocomplete,
                    onSelectPlugin: onSelectPluginAutocomplete
                )
            }

            if !state.isFileAutocompleteVisible && state.isPluginAutocompleteVisible {
                FileAutocompletePanel(
                    items: [],
                    pluginItems: state.pluginAutocompleteItems,
                    isLoading: false,
                    isLoadingPlugins: state.isPluginAutocompleteLoading,
                    query: state.pluginAutocompleteQuery,
                    pluginQuery: state.pluginAutocompleteQuery,
                    onSelect: onSelectFileAutocomplete,
                    onSelectPlugin: onSelectPluginAutocomplete
                )
            }

            if state.isSkillAutocompleteVisible {
                SkillAutocompletePanel(
                    items: state.skillAutocompleteItems,
                    isLoading: state.isSkillAutocompleteLoading,
                    query: state.skillAutocompleteQuery,
                    trigger: state.skillAutocompleteTrigger,
                    onSelect: onSelectSkillAutocomplete
                )
            }

            if state.slashCommandPanelState != .hidden {
                SlashCommandAutocompletePanel(
                    state: state.slashCommandPanelState,
                    availableCommands: state.availableSlashCommands,
                    hasComposerContentConflictingWithReview: state.hasComposerContentConflictingWithReview,
                    isThreadRunning: state.isThreadRunning,
                    showsGitBranchSelector: state.showsGitBranchSelector,
                    isLoadingGitBranchTargets: state.isLoadingGitBranchTargets,
                    availableGitBranchTargets: state.availableGitBranchTargets,
                    selectedGitBaseBranch: state.selectedGitBaseBranch,
                    gitDefaultBranch: state.gitDefaultBranch,
                    onSelectCommand: onSelectSlashCommand,
                    onSelectReviewTarget: onSelectCodeReviewTarget,
                    onSelectForkDestination: onSelectForkDestination,
                    onClose: onCloseSlashCommandPanel
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .layoutPriority(1)
        .zIndex(1)
    }
}

struct TurnComposerQueuedDraftsSection: View {
    let drafts: [QueuedTurnDraft]
    let canSteerDrafts: Bool
    let canRestoreDrafts: Bool
    let steeringDraftID: String?
    let onRestoreQueuedDraft: (String) -> Void
    let onSteerQueuedDraft: (String) -> Void
    let onRemoveQueuedDraft: (String) -> Void

    var body: some View {
        Group {
            if !drafts.isEmpty {
                QueuedDraftsPanel(
                    drafts: drafts,
                    canSteerDrafts: canSteerDrafts,
                    canRestoreDrafts: canRestoreDrafts,
                    steeringDraftID: steeringDraftID,
                    onRestore: onRestoreQueuedDraft,
                    onSteer: onSteerQueuedDraft,
                    onRemove: onRemoveQueuedDraft
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding([.horizontal, .bottom], 4)
                .adaptiveGlass(.regular, in: UnevenRoundedRectangle(
                    topLeadingRadius: 28,
                    bottomLeadingRadius: 0,
                    bottomTrailingRadius: 0,
                    topTrailingRadius: 28,
                    style: .continuous
                ))
                .padding(.bottom, -10)
                .padding(.horizontal, 16)
            }
        }
    }
}

struct TurnComposerAccessorySection: View {
    let state: TurnComposerAccessoryState
    let onRemoveAttachment: (String) -> Void
    let onRemoveMentionedFile: (String) -> Void
    let onRemoveMentionedSkill: (String) -> Void
    let onRemoveMentionedPlugin: (String) -> Void
    let onRemoveComposerReviewSelection: () -> Void
    let onRemoveComposerSubagentsSelection: () -> Void

    var body: some View {
        Group {
            if state.showsComposerAttachments {
                ComposerAttachmentsPreview(
                    attachments: state.composerAttachments,
                    onRemove: onRemoveAttachment
                )
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 8)
            }

            if state.showsMentionedFiles {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(state.composerMentionedFiles) { file in
                            FileMentionChip(fileName: file.fileName) {
                                onRemoveMentionedFile(file.id)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.top, 10)
            }

            if state.showsMentionedSkills {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(state.composerMentionedSkills) { skill in
                            SkillMentionChip(skillName: skill.name) {
                                onRemoveMentionedSkill(skill.id)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }

            if state.showsMentionedPlugins {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(state.composerMentionedPlugins) { plugin in
                            PluginMentionChip(pluginName: plugin.displayName ?? plugin.name) {
                                onRemoveMentionedPlugin(plugin.id)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }

            if state.showsSubagentsSelection {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ComposerActionChip(
                            title: "Subagents",
                            symbolName: "point.3.connected.trianglepath.dotted",
                            tintColor: .teal,
                            removeAccessibilityLabel: "Remove subagents"
                        ) {
                            onRemoveComposerSubagentsSelection()
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }

            if let reviewTarget = state.reviewTarget {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ComposerActionChip(
                            title: "Code Review: \(reviewTarget.title)",
                            symbolName: "checklist",
                            tintColor: .teal,
                            removeAccessibilityLabel: "Remove code review"
                        ) {
                            onRemoveComposerReviewSelection()
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }
        }
    }
}
