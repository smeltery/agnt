// FILE: SidebarProjectStateTests.swift
// Purpose: Verifies sidebar project expansion and preview state behavior.
// Layer: Unit Test
// Exports: SidebarProjectStateTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

final class SidebarProjectStateTests: SidebarThreadGroupingTestCase {
    func testProjectExpansionStateInitiallyExpandsAllVisibleGroups() {
        let groups = [
            makeProjectGroup(id: "project:/Users/me/work/app"),
            makeProjectGroup(id: "project:/Users/me/work/site"),
        ]

        let snapshot = SidebarProjectExpansionState.synchronizedState(
            currentExpandedGroupIDs: [],
            knownGroupIDs: [],
            visibleGroups: groups,
            hasInitialized: false
        )

        XCTAssertEqual(snapshot.expandedGroupIDs, Set(groups.map(\.id)))
        XCTAssertEqual(snapshot.knownGroupIDs, Set(groups.map(\.id)))
    }

    func testProjectExpansionStateInitiallyKeepsPersistedCollapsedGroupsClosed() {
        let groups = [
            makeProjectGroup(id: "project:/Users/me/work/app"),
            makeProjectGroup(id: "project:/Users/me/work/site"),
        ]

        let snapshot = SidebarProjectExpansionState.synchronizedState(
            currentExpandedGroupIDs: [],
            knownGroupIDs: [],
            visibleGroups: groups,
            hasInitialized: false,
            persistedCollapsedGroupIDs: Set(["project:/Users/me/work/site"])
        )

        XCTAssertEqual(snapshot.expandedGroupIDs, Set(["project:/Users/me/work/app"]))
        XCTAssertEqual(snapshot.knownGroupIDs, Set(groups.map(\.id)))
    }

    func testProjectExpansionStatePreservesCollapsedGroupsAcrossRefreshes() {
        let groups = [
            makeProjectGroup(id: "project:/Users/me/work/app"),
            makeProjectGroup(id: "project:/Users/me/work/site"),
        ]

        let snapshot = SidebarProjectExpansionState.synchronizedState(
            currentExpandedGroupIDs: ["project:/Users/me/work/app"],
            knownGroupIDs: Set(groups.map(\.id)),
            visibleGroups: groups,
            hasInitialized: true
        )

        XCTAssertEqual(snapshot.expandedGroupIDs, ["project:/Users/me/work/app"])
    }

    func testProjectExpansionStateAutoExpandsNewProjectGroupsOnly() {
        let existingGroups = [
            makeProjectGroup(id: "project:/Users/me/work/app"),
            makeProjectGroup(id: "project:/Users/me/work/site"),
        ]
        let updatedGroups = existingGroups + [makeProjectGroup(id: "project:/Users/me/work/docs")]

        let snapshot = SidebarProjectExpansionState.synchronizedState(
            currentExpandedGroupIDs: ["project:/Users/me/work/app"],
            knownGroupIDs: Set(existingGroups.map(\.id)),
            visibleGroups: updatedGroups,
            hasInitialized: true
        )

        XCTAssertEqual(
            snapshot.expandedGroupIDs,
            ["project:/Users/me/work/app", "project:/Users/me/work/docs"]
        )
    }

    func testProjectExpansionStateKeepsPersistedCollapsedGroupsClosedWhenThreadsLoadLater() {
        let groups = [
            makeProjectGroup(id: "project:/Users/me/work/app"),
            makeProjectGroup(id: "project:/Users/me/work/site"),
        ]

        let initialSnapshot = SidebarProjectExpansionState.synchronizedState(
            currentExpandedGroupIDs: [],
            knownGroupIDs: [],
            visibleGroups: [],
            hasInitialized: false,
            persistedCollapsedGroupIDs: Set(["project:/Users/me/work/site"])
        )
        let loadedSnapshot = SidebarProjectExpansionState.synchronizedState(
            currentExpandedGroupIDs: initialSnapshot.expandedGroupIDs,
            knownGroupIDs: initialSnapshot.knownGroupIDs,
            visibleGroups: groups,
            hasInitialized: true,
            persistedCollapsedGroupIDs: Set(["project:/Users/me/work/site"])
        )

        XCTAssertEqual(loadedSnapshot.expandedGroupIDs, Set(["project:/Users/me/work/app"]))
    }

    func testProjectExpansionStateKeepsPersistedCollapsedGroupsClosedWhenTheyReappear() {
        let appGroup = makeProjectGroup(id: "project:/Users/me/work/app")
        let siteGroup = makeProjectGroup(id: "project:/Users/me/work/site")

        let hiddenSnapshot = SidebarProjectExpansionState.synchronizedState(
            currentExpandedGroupIDs: ["project:/Users/me/work/app"],
            knownGroupIDs: Set([appGroup.id, siteGroup.id]),
            visibleGroups: [appGroup],
            hasInitialized: true,
            persistedCollapsedGroupIDs: Set([siteGroup.id])
        )
        let restoredSnapshot = SidebarProjectExpansionState.synchronizedState(
            currentExpandedGroupIDs: hiddenSnapshot.expandedGroupIDs,
            knownGroupIDs: hiddenSnapshot.knownGroupIDs,
            visibleGroups: [appGroup, siteGroup],
            hasInitialized: true,
            persistedCollapsedGroupIDs: Set([siteGroup.id])
        )

        XCTAssertEqual(restoredSnapshot.expandedGroupIDs, Set([appGroup.id]))
    }

    func testGroupIDContainingSelectedThreadReturnsOwningProjectGroup() {
        let selectedThread = makeThread(
            id: "thread-a",
            updatedAt: Date(timeIntervalSince1970: 1_700_000_000),
            cwd: "/Users/me/work/app"
        )
        let groups = [
            SidebarThreadGroup(
                id: "project:/Users/me/work/app",
                label: "app",
                kind: .project,
                sortDate: selectedThread.updatedAt ?? .distantPast,
                projectPath: "/Users/me/work/app",
                threads: [selectedThread]
            ),
            makeProjectGroup(id: "project:/Users/me/work/site"),
        ]

        let groupID = SidebarProjectExpansionState.groupIDContainingSelectedThread(selectedThread, in: groups)

        XCTAssertEqual(groupID, "project:/Users/me/work/app")
    }

    func testPersistedGroupIDsRoundTrip() {
        let encoded = SidebarProjectExpansionState.encodePersistedGroupIDs([
            "project:/Users/me/work/site",
            "project:/Users/me/work/app",
        ])

        let decoded = SidebarProjectExpansionState.decodePersistedGroupIDs(encoded)

        XCTAssertEqual(decoded, Set([
            "project:/Users/me/work/app",
            "project:/Users/me/work/site",
        ]))
    }

    func testShouldAutoRevealSelectedGroupSkipsPersistedCollapsedGroup() {
        let shouldReveal = SidebarProjectExpansionState.shouldAutoRevealSelectedGroup(
            "project:/Users/me/work/app",
            persistedCollapsedGroupIDs: Set(["project:/Users/me/work/app"])
        )

        XCTAssertFalse(shouldReveal)
    }

    func testProjectThreadPreviewStateShowsOnlyLatestSixRootThreadsByDefault() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = (0..<12).map { index in
            makeThread(
                id: "thread-\(index)",
                updatedAt: now.addingTimeInterval(TimeInterval(index * -60)),
                cwd: "/Users/me/work/app"
            )
        }
        let group = SidebarThreadGrouping.makeGroups(from: threads).first { $0.id == "project:/Users/me/work/app" }
        let projectGroup = try XCTUnwrap(group)

        let visibleRootThreads = SidebarProjectThreadPreviewState.visibleRootThreads(
            for: projectGroup,
            selectedThread: nil,
            isFiltering: false,
            manuallyExpandedGroupIDs: []
        )

        XCTAssertEqual(visibleRootThreads.count, 6)
        XCTAssertEqual(visibleRootThreads.map(\.id), (0..<6).map { "thread-\($0)" })
        XCTAssertTrue(
            SidebarProjectThreadPreviewState.shouldShowMoreButton(
                for: projectGroup,
                selectedThread: nil,
                isFiltering: false,
                manuallyExpandedGroupIDs: []
            )
        )
    }

    func testProjectThreadPreviewStateAutoRevealsSelectedOlderRootThread() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let threads = (0..<12).map { index in
            makeThread(
                id: "thread-\(index)",
                updatedAt: now.addingTimeInterval(TimeInterval(index * -60)),
                cwd: "/Users/me/work/app"
            )
        }
        let group = try XCTUnwrap(
            SidebarThreadGrouping.makeGroups(from: threads).first { $0.id == "project:/Users/me/work/app" }
        )

        let visibleRootThreads = SidebarProjectThreadPreviewState.visibleRootThreads(
            for: group,
            selectedThread: threads[11],
            isFiltering: false,
            manuallyExpandedGroupIDs: []
        )

        XCTAssertEqual(visibleRootThreads.map(\.id), threads.map(\.id))
        XCTAssertFalse(
            SidebarProjectThreadPreviewState.shouldShowMoreButton(
                for: group,
                selectedThread: threads[11],
                isFiltering: false,
                manuallyExpandedGroupIDs: []
            )
        )
    }

    func testProjectThreadPreviewStateAutoRevealsSelectedSubagentWhenParentFallsPastCutoff() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        var threads = (0..<11).map { index in
            makeThread(
                id: "thread-\(index)",
                updatedAt: now.addingTimeInterval(TimeInterval(index * -60)),
                cwd: "/Users/me/work/app"
            )
        }
        let selectedSubagent = makeThread(
            id: "thread-10-subagent",
            updatedAt: now.addingTimeInterval(-30),
            cwd: "/Users/me/work/app",
            parentThreadId: "thread-10"
        )
        threads.append(selectedSubagent)
        let group = try XCTUnwrap(
            SidebarThreadGrouping.makeGroups(from: threads).first { $0.id == "project:/Users/me/work/app" }
        )

        let visibleRootThreads = SidebarProjectThreadPreviewState.visibleRootThreads(
            for: group,
            selectedThread: selectedSubagent,
            isFiltering: false,
            manuallyExpandedGroupIDs: []
        )

        XCTAssertEqual(visibleRootThreads.map(\.id), (0..<11).map { "thread-\($0)" })
        XCTAssertFalse(
            SidebarProjectThreadPreviewState.shouldShowMoreButton(
                for: group,
                selectedThread: selectedSubagent,
                isFiltering: false,
                manuallyExpandedGroupIDs: []
            )
        )
    }
}
