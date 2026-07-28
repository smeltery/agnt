// FILE: SidebarThreadGroupingTests.swift
// Purpose: Guards sidebar grouping so chats stay partitioned by project path instead of time buckets.
// Layer: Unit Test
// Exports: SidebarThreadGroupingTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

final class SidebarThreadGroupingTests: SidebarThreadGroupingTestCase {
    func testMakeGroupsPartitionsLiveThreadsByProjectPath() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "thread-a", updatedAt: now, cwd: "/Users/me/work/app"),
            makeThread(id: "thread-b", updatedAt: now.addingTimeInterval(-60), cwd: "/Users/me/work/app///"),
            makeThread(id: "thread-c", updatedAt: now.addingTimeInterval(-120), cwd: "/Users/me/work/site"),
        ]

        let groups = SidebarThreadGrouping.makeGroups(from: threads, now: now)

        XCTAssertEqual(groups.map(\.id), ["project:/Users/me/work/app", "project:/Users/me/work/site"])
        XCTAssertEqual(groups.first?.label, "app")
        XCTAssertEqual(groups.first?.projectPath, "/Users/me/work/app")
        XCTAssertEqual(groups.first?.threads.map(\.id), ["thread-a", "thread-b"])
        XCTAssertEqual(groups.last?.threads.map(\.id), ["thread-c"])
    }

    func testMakeGroupsCreatesNoProjectBucketForThreadsWithoutCwd() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "thread-a", updatedAt: now, cwd: nil),
            makeThread(id: "thread-b", updatedAt: now.addingTimeInterval(-30), cwd: "   "),
        ]

        let groups = SidebarThreadGrouping.makeGroups(from: threads, now: now)

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].id, "project:__no_project__")
        XCTAssertEqual(groups[0].label, "No Project")
        XCTAssertNil(groups[0].projectPath)
        XCTAssertEqual(groups[0].threads.map(\.id), ["thread-a", "thread-b"])
    }

    func testMakeGroupsTreatsGeneratedProjectlessRootsAsNoProject() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "thread-a", updatedAt: now, cwd: "/Users/me/.codex/threads/abc123"),
            makeThread(id: "thread-b", updatedAt: now.addingTimeInterval(-30), cwd: "/Users/me/Documents/Codex/2026-05-18/hello"),
            makeThread(id: "thread-c", updatedAt: now.addingTimeInterval(-60), cwd: "/Users/me/work/app"),
        ]

        let groups = SidebarThreadGrouping.makeGroups(
            from: threads,
            projectlessRootPaths: ["/Users/me/.custom-codex/threads"]
        )

        XCTAssertEqual(groups.map(\.id), ["project:__no_project__", "project:/Users/me/work/app"])
        XCTAssertEqual(groups[0].label, "No Project")
        XCTAssertNil(groups[0].projectPath)
        XCTAssertEqual(groups[0].threads.map(\.id), ["thread-a", "thread-b"])
    }

    func testMakeGroupsTreatsCustomProjectlessRootsAsNoProject() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "thread-a", updatedAt: now, cwd: "/Users/me/.custom-codex/threads/abc123"),
            makeThread(id: "thread-b", updatedAt: now.addingTimeInterval(-30), cwd: "/Users/me/work/app"),
        ]

        let groups = SidebarThreadGrouping.makeGroups(
            from: threads,
            projectlessRootPaths: ["/Users/me/.custom-codex/threads"]
        )

        XCTAssertEqual(groups.map(\.id), ["project:__no_project__", "project:/Users/me/work/app"])
        XCTAssertEqual(groups[0].threads.map(\.id), ["thread-a"])
    }

    func testMakeGroupsTreatsPseudoProjectBucketsAsNoProject() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "thread-a", updatedAt: now, cwd: "server"),
            makeThread(id: "thread-b", updatedAt: now.addingTimeInterval(-30), cwd: "_default"),
        ]

        let groups = SidebarThreadGrouping.makeGroups(from: threads, now: now)

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].id, "project:__no_project__")
        XCTAssertEqual(groups[0].label, "No Project")
        XCTAssertNil(groups[0].projectPath)
        XCTAssertEqual(groups[0].threads.map(\.id), ["thread-a", "thread-b"])
    }

    func testMakeGroupsExcludesEphemeralThreadsFromSavedChatSections() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "project-thread", updatedAt: now, cwd: "/Users/me/work/app"),
            makeThread(
                id: "ephemeral-thread",
                updatedAt: now.addingTimeInterval(60),
                cwd: "/Users/me/work/app",
                ephemeral: true
            ),
            makeThread(
                id: "ephemeral-rootless",
                updatedAt: now.addingTimeInterval(120),
                cwd: nil,
                ephemeral: true
            ),
        ]

        let projectGroups = SidebarThreadGrouping.makeGroups(from: threads, now: now)
        XCTAssertEqual(projectGroups.map(\.id), ["project:/Users/me/work/app"])
        XCTAssertEqual(projectGroups[0].threads.map(\.id), ["project-thread"])

        let chatGroups = SidebarThreadGrouping.makeGroups(from: threads, scope: .chats, now: now)
        XCTAssertTrue(chatGroups.isEmpty)
    }

    func testMakeGroupsKeepsArchivedThreadsInDedicatedTrailingSection() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "live-thread", updatedAt: now, cwd: "/Users/me/work/app"),
            makeThread(
                id: "archived-thread",
                updatedAt: now.addingTimeInterval(600),
                cwd: "/Users/me/work/archived",
                syncState: .archivedLocal
            ),
        ]

        let groups = SidebarThreadGrouping.makeGroups(from: threads, now: now)

        XCTAssertEqual(groups.map(\.id), ["project:/Users/me/work/app", "archived"])
        XCTAssertEqual(groups[1].kind, .archived)
        XCTAssertNil(groups[1].projectPath)
        XCTAssertEqual(groups[1].threads.map(\.id), ["archived-thread"])
    }

    func testProjectsScopeExcludesRootlessChats() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "project-thread", updatedAt: now, cwd: "/Users/me/work/app"),
            makeThread(id: "rootless-thread", updatedAt: now.addingTimeInterval(-30), cwd: nil),
        ]

        let groups = SidebarThreadGrouping.makeGroups(from: threads, scope: .projects, now: now)

        XCTAssertEqual(groups.map(\.id), ["project:/Users/me/work/app"])
        XCTAssertEqual(groups[0].threads.map(\.id), ["project-thread"])
    }

    func testChatsScopeProducesSingleRootlessChatGroup() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "project-thread", updatedAt: now, cwd: "/Users/me/work/app"),
            makeThread(id: "rootless-a", updatedAt: now.addingTimeInterval(-30), cwd: nil),
            makeThread(id: "rootless-b", updatedAt: now.addingTimeInterval(-60), cwd: "   "),
        ]

        let groups = SidebarThreadGrouping.makeGroups(from: threads, scope: .chats, now: now)

        XCTAssertEqual(groups.map(\.id), ["chats:rootless"])
        XCTAssertEqual(groups[0].kind, .chat)
        XCTAssertEqual(groups[0].label, "Chats")
        XCTAssertNil(groups[0].projectPath)
        XCTAssertEqual(groups[0].threads.map(\.id), ["rootless-a", "rootless-b"])
    }

    func testChatsScopeIsEmptyWhenNoRootlessChatsExist() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "project-thread", updatedAt: now, cwd: "/Users/me/work/app"),
        ]

        let groups = SidebarThreadGrouping.makeGroups(from: threads, scope: .chats, now: now)

        XCTAssertTrue(groups.isEmpty)
    }

    func testMakeGroupsLiftsPinnedThreadsIntoDedicatedLeadingSection() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "thread-a", updatedAt: now, cwd: "/Users/me/work/app"),
            makeThread(id: "thread-b", updatedAt: now.addingTimeInterval(-60), cwd: "/Users/me/work/site"),
            makeThread(id: "thread-c", updatedAt: now.addingTimeInterval(-120), cwd: "/Users/me/work/app"),
        ]

        let groups = SidebarThreadGrouping.makeGroups(
            from: threads,
            pinnedThreadIDs: ["thread-b", "thread-a"]
        )

        XCTAssertEqual(groups.map(\.id), ["pinned", "project:/Users/me/work/app"])
        XCTAssertEqual(groups.first?.kind, .pinned)
        XCTAssertEqual(groups.first?.threads.map(\.id), ["thread-b", "thread-a"])
        XCTAssertEqual(groups.last?.threads.map(\.id), ["thread-c"])
    }

    func testMakeGroupsIgnoresArchivedPinnedThreads() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "live-thread", updatedAt: now, cwd: "/Users/me/work/app"),
            makeThread(
                id: "archived-thread",
                updatedAt: now.addingTimeInterval(-60),
                cwd: "/Users/me/work/site",
                syncState: .archivedLocal
            ),
        ]

        let groups = SidebarThreadGrouping.makeGroups(
            from: threads,
            pinnedThreadIDs: ["archived-thread", "live-thread"]
        )

        XCTAssertEqual(groups.map(\.id), ["pinned", "project:/Users/me/work/app", "archived"])
        XCTAssertEqual(groups.first?.threads.map(\.id), ["live-thread"])
        XCTAssertEqual(groups[2].threads.map(\.id), ["archived-thread"])
    }

    func testMakeGroupsKeepsPinnedRootSubtreeTogetherAndOutOfProjectSection() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let rootThread = makeThread(id: "root-thread", updatedAt: now, cwd: "/Users/me/work/app")
        let childThread = makeThread(
            id: "child-thread",
            updatedAt: now.addingTimeInterval(-30),
            cwd: "/Users/me/work/app",
            parentThreadId: "root-thread"
        )
        let siblingThread = makeThread(
            id: "sibling-thread",
            updatedAt: now.addingTimeInterval(-60),
            cwd: "/Users/me/work/app"
        )

        let groups = SidebarThreadGrouping.makeGroups(
            from: [rootThread, childThread, siblingThread],
            pinnedThreadIDs: ["root-thread"]
        )

        XCTAssertEqual(groups.map(\.id), ["pinned", "project:/Users/me/work/app"])
        XCTAssertEqual(groups.first?.threads.map(\.id), ["root-thread", "child-thread"])
        XCTAssertEqual(groups.last?.threads.map(\.id), ["sibling-thread"])
    }

    func testMakeGroupsMarksCodexManagedWorktreesInLabelAndIcon() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "main-thread", updatedAt: now, cwd: "/Users/me/work/agnt"),
            makeThread(
                id: "worktree-thread",
                updatedAt: now.addingTimeInterval(-60),
                cwd: "/Users/me/.codex/worktrees/ce15/agnt"
            ),
        ]

        let groups = SidebarThreadGrouping.makeGroups(from: threads, now: now)
        let mainGroup = try XCTUnwrap(groups.first(where: { $0.projectPath == "/Users/me/work/agnt" }))
        let worktreeGroup = try XCTUnwrap(
            groups.first(where: { $0.projectPath == "/Users/me/.codex/worktrees/ce15/agnt" })
        )

        XCTAssertEqual(mainGroup.label, "agnt")
        XCTAssertEqual(mainGroup.iconSystemName, "folder")
        XCTAssertEqual(worktreeGroup.label, "agnt 15")
        XCTAssertEqual(worktreeGroup.iconSystemName, "arrow.triangle.branch")
    }

    func testMakeGroupsPlacesManagedWorktreeThreadsUnderOriginProjectWhenAvailable() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let originPath = "/Users/me/work/agnt"
        let worktreePath = "/Users/me/.codex/worktrees/ce15/agnt"
        let threads = [
            makeThread(id: "main-thread", updatedAt: now, cwd: originPath),
            makeThread(
                id: "worktree-thread",
                updatedAt: now.addingTimeInterval(-60),
                cwd: worktreePath,
                worktreeOriginPath: originPath
            ),
        ]

        let groups = SidebarThreadGrouping.makeGroups(from: threads, now: now)

        XCTAssertEqual(groups.map(\.id), ["project:/Users/me/work/agnt"])
        XCTAssertEqual(groups[0].projectPath, originPath)
        XCTAssertEqual(groups[0].label, "agnt")
        XCTAssertEqual(groups[0].threads.map(\.id), ["main-thread", "worktree-thread"])
    }

    func testMakeGroupsLiftsRunningAndReadyThreadsAheadOfNewerIdleThreads() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "running-thread", updatedAt: now.addingTimeInterval(-3_600), cwd: "/Users/me/work/app"),
            makeThread(id: "newer-idle-thread", updatedAt: now, cwd: "/Users/me/work/app"),
            makeThread(id: "ready-thread", updatedAt: now.addingTimeInterval(-1_800), cwd: "/Users/me/work/app"),
            makeThread(id: "other-project-thread", updatedAt: now.addingTimeInterval(-30), cwd: "/Users/me/work/site"),
        ]

        let groups = SidebarThreadGrouping.makeGroups(
            from: threads,
            runBadgeStateByThreadID: [
                "running-thread": .running,
                "ready-thread": .ready,
            ],
            now: now
        )

        XCTAssertEqual(groups.map(\.id), ["project:/Users/me/work/app", "project:/Users/me/work/site"])
        XCTAssertEqual(groups.first?.threads.map(\.id), ["running-thread", "ready-thread", "newer-idle-thread"])
    }

    func testMakeGroupsKeepsApprovalWaitingThreadsAtTheFront() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "running-thread", updatedAt: now, cwd: "/Users/me/work/app"),
            makeThread(id: "approval-thread", updatedAt: now.addingTimeInterval(-3_600), cwd: "/Users/me/work/app"),
            makeThread(id: "ready-thread", updatedAt: now.addingTimeInterval(60), cwd: "/Users/me/work/app"),
        ]

        let groups = SidebarThreadGrouping.makeGroups(
            from: threads,
            runBadgeStateByThreadID: [
                "approval-thread": .waitingOnUser,
                "running-thread": .running,
                "ready-thread": .ready,
            ],
            now: now
        )

        XCTAssertEqual(groups.first?.threads.map(\.id), ["approval-thread", "running-thread", "ready-thread"])
    }

    func testMakeGroupsKeepsRecencyOrderingWhenRunBadgesAreAbsent() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "older-app-thread", updatedAt: now.addingTimeInterval(-3_600), cwd: "/Users/me/work/app"),
            makeThread(id: "newer-app-thread", updatedAt: now, cwd: "/Users/me/work/app"),
            makeThread(id: "site-thread", updatedAt: now.addingTimeInterval(-30), cwd: "/Users/me/work/site"),
        ]

        let groups = SidebarThreadGrouping.makeGroups(from: threads, now: now)

        XCTAssertEqual(groups.map(\.id), ["project:/Users/me/work/app", "project:/Users/me/work/site"])
        XCTAssertEqual(groups.first?.threads.map(\.id), ["newer-app-thread", "older-app-thread"])
    }

    func testMakeProjectChoicesReusesLiveProjectBucketsAndSkipsNoProject() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "app-thread", updatedAt: now, cwd: "/Users/me/work/app"),
            makeThread(id: "site-thread", updatedAt: now.addingTimeInterval(-60), cwd: "/Users/me/work/site"),
            makeThread(id: "no-project-thread", updatedAt: now.addingTimeInterval(-120), cwd: nil),
            makeThread(id: "generated-chat-thread", updatedAt: now.addingTimeInterval(-130), cwd: "/Users/me/.codex/threads/abc123"),
            makeThread(
                id: "archived-thread",
                updatedAt: now.addingTimeInterval(60),
                cwd: "/Users/me/work/archived",
                syncState: .archivedLocal
            ),
        ]

        let choices = SidebarThreadGrouping.makeProjectChoices(from: threads)

        XCTAssertEqual(choices.map(\.label), ["app", "site"])
        XCTAssertEqual(choices.map(\.iconSystemName), ["folder", "folder"])
        XCTAssertEqual(choices.map(\.projectPath), ["/Users/me/work/app", "/Users/me/work/site"])
    }

    func testMakeProjectChoicesKeepWorktreeSelectionCompactWithoutShowingPathInLabel() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = [
            makeThread(id: "main-thread", updatedAt: now, cwd: "/Users/me/work/agnt"),
            makeThread(
                id: "worktree-thread",
                updatedAt: now.addingTimeInterval(-60),
                cwd: "/Users/me/.codex/worktrees/ce15/agnt"
            ),
        ]

        let choices = SidebarThreadGrouping.makeProjectChoices(from: threads)
        let labelsByPath = Dictionary(uniqueKeysWithValues: choices.map { ($0.projectPath, $0) })

        XCTAssertEqual(labelsByPath["/Users/me/work/agnt"]?.label, "agnt")
        XCTAssertEqual(labelsByPath["/Users/me/work/agnt"]?.iconSystemName, "folder")
        XCTAssertEqual(labelsByPath["/Users/me/.codex/worktrees/ce15/agnt"]?.label, "agnt 15")
        XCTAssertEqual(labelsByPath["/Users/me/.codex/worktrees/ce15/agnt"]?.iconSystemName, "arrow.triangle.branch")
    }

    func testLiveThreadIDsForProjectGroupUsesAllThreadsNotJustFilteredMatches() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let allThreads = [
            makeThread(id: "app-thread-1", updatedAt: now, cwd: "/Users/me/work/app"),
            makeThread(id: "app-thread-2", updatedAt: now.addingTimeInterval(-60), cwd: "/Users/me/work/app"),
            makeThread(id: "site-thread", updatedAt: now.addingTimeInterval(-120), cwd: "/Users/me/work/site"),
        ]
        let filteredGroup = SidebarThreadGroup(
            id: "project:/Users/me/work/app",
            label: "app",
            kind: .project,
            sortDate: now,
            projectPath: "/Users/me/work/app",
            threads: [allThreads[0]]
        )

        let threadIDs = SidebarThreadGrouping.liveThreadIDsForProjectGroup(filteredGroup, in: allThreads)

        XCTAssertEqual(threadIDs, ["app-thread-1", "app-thread-2"])
    }

    func testLiveThreadIDsForProjectGroupKeepsNoProjectChatsTogether() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let allThreads = [
            makeThread(id: "no-project-1", updatedAt: now, cwd: nil),
            makeThread(id: "no-project-2", updatedAt: now.addingTimeInterval(-30), cwd: " "),
            makeThread(id: "project-thread", updatedAt: now.addingTimeInterval(-60), cwd: "/Users/me/work/app"),
        ]
        let noProjectGroup = SidebarThreadGroup(
            id: "project:__no_project__",
            label: "No Project",
            kind: .project,
            sortDate: now,
            projectPath: nil,
            threads: [allThreads[0]]
        )

        let threadIDs = SidebarThreadGrouping.liveThreadIDsForProjectGroup(noProjectGroup, in: allThreads)

        XCTAssertEqual(threadIDs, ["no-project-1", "no-project-2"])
    }

}
