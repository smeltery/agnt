// FILE: AgntQuickActionCenter.swift
// Purpose: Publishes Home Screen quick actions and routes selected shortcuts
//          back into the SwiftUI root.
// Layer: App
// Exports: AgntQuickAction, AgntQuickActionCenter

import Foundation
import UIKit

enum AgntQuickAction: Equatable, Sendable {
    case newChat
    case thread(id: String)
}

@MainActor
enum AgntQuickActionCenter {
    static let didReceiveQuickAction = Notification.Name("agnt.didReceiveQuickAction")

    private static let newChatType = "com.dotbrains.agnt.quickAction.newChat"
    private static let threadType = "com.dotbrains.agnt.quickAction.thread"
    private static let threadIDUserInfoKey = "threadId"
    private static var pendingAction: AgntQuickAction?

    static func updateShortcutItems(for threads: [CodexThread]) {
        UIApplication.shared.shortcutItems = shortcutItems(for: threads)
    }

    @discardableResult
    static func handleShortcutItem(_ shortcutItem: UIApplicationShortcutItem) -> Bool {
        guard let action = action(from: shortcutItem) else {
            return false
        }

        pendingAction = action
        NotificationCenter.default.post(
            name: didReceiveQuickAction,
            object: nil,
            userInfo: ["action": action]
        )
        return true
    }

    static func consumePendingAction() -> AgntQuickAction? {
        let action = pendingAction
        pendingAction = nil
        return action
    }

    private static func shortcutItems(for threads: [CodexThread]) -> [UIApplicationShortcutItem] {
        let recentThreads = threads
            .filter { $0.syncState == .live }
            .prefix(2)

        return [newChatShortcutItem()] + recentThreads.map(threadShortcutItem)
    }

    private static func newChatShortcutItem() -> UIApplicationShortcutItem {
        UIApplicationShortcutItem(
            type: newChatType,
            localizedTitle: "New Chat",
            localizedSubtitle: nil,
            icon: UIApplicationShortcutIcon(systemImageName: "square.and.pencil"),
            userInfo: nil
        )
    }

    private static func threadShortcutItem(for thread: CodexThread) -> UIApplicationShortcutItem {
        UIApplicationShortcutItem(
            type: threadType,
            localizedTitle: thread.displayTitle,
            localizedSubtitle: projectSubtitle(for: thread),
            icon: UIApplicationShortcutIcon(systemImageName: "bubble.left.and.bubble.right"),
            userInfo: [threadIDUserInfoKey: thread.id as NSString]
        )
    }

    private static func projectSubtitle(for thread: CodexThread) -> String {
        let projectName = thread.projectDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !projectName.isEmpty, projectName != CodexThread.noProjectDisplayName else {
            return "Chats"
        }
        return projectName
    }

    private static func action(from shortcutItem: UIApplicationShortcutItem) -> AgntQuickAction? {
        switch shortcutItem.type {
        case newChatType:
            return .newChat
        case threadType:
            guard let threadID = shortcutItem.userInfo?[threadIDUserInfoKey] as? String else {
                return nil
            }
            let normalizedThreadID = threadID.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !normalizedThreadID.isEmpty else {
                return nil
            }
            return .thread(id: normalizedThreadID)
        default:
            return nil
        }
    }
}
