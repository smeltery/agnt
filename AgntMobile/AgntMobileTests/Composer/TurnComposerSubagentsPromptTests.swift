// FILE: TurnComposerSubagentsPromptTests.swift
// Purpose: Verifies subagents slash-command prompt composition before send.
// Layer: Unit Test
// Exports: TurnComposerSubagentsPromptTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class TurnComposerSubagentsPromptTests: TurnComposerSendTestCase {
    func testSendTurnUsesCannedPromptWhenSubagentsChipIsSelected() async {
        let service = makeService()
        service.isConnected = true

        var capturedParams: JSONValue?
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/start")
            capturedParams = params
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-subagents")]),
                includeJSONRPC: false
            )
        }

        let viewModel = TurnViewModel()
        viewModel.input = "/sub"
        viewModel.slashCommandPanelState = .commands(query: "sub")
        viewModel.onSelectSlashCommand(.subagents)

        viewModel.sendTurn(codex: service, threadID: "thread-subagents")
        await waitForSendCompletion(viewModel)

        XCTAssertEqual(
            textInput(from: capturedParams),
            "Run subagents for different tasks. Delegate distinct work in parallel when helpful and then synthesize the results."
        )
    }

    func testSendTurnPrefixesDraftTextWhenSubagentsChipIsSelected() async {
        let service = makeService()
        service.isConnected = true

        var capturedParams: JSONValue?
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/start")
            capturedParams = params
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-literal-subagents")]),
                includeJSONRPC: false
            )
        }

        let viewModel = TurnViewModel()
        viewModel.input = "/sub"
        viewModel.slashCommandPanelState = .commands(query: "sub")
        viewModel.onSelectSlashCommand(.subagents)

        viewModel.input = "Please explain what /subagents does."

        viewModel.sendTurn(codex: service, threadID: "thread-literal-subagents")
        await waitForSendCompletion(viewModel)

        XCTAssertEqual(
            textInput(from: capturedParams),
            "Run subagents for different tasks. Delegate distinct work in parallel when helpful and then synthesize the results.\n\nPlease explain what /subagents does."
        )
    }

    func testSendTurnPrefixesPromptBeforeOrdinaryDraftText() async {
        let service = makeService()
        service.isConnected = true

        var capturedParams: JSONValue?
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/start")
            capturedParams = params
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-shifted-subagents")]),
                includeJSONRPC: false
            )
        }

        let viewModel = TurnViewModel()
        viewModel.input = "Please explain /subagents too."
        viewModel.isSubagentsSelectionArmed = true

        viewModel.sendTurn(codex: service, threadID: "thread-shifted-subagents")
        await waitForSendCompletion(viewModel)

        XCTAssertEqual(
            textInput(from: capturedParams),
            "Run subagents for different tasks. Delegate distinct work in parallel when helpful and then synthesize the results.\n\nPlease explain /subagents too."
        )
    }

    func testSendTurnTrimsLeadingWhitespaceBeforeApplyingSubagentsPrompt() async {
        let service = makeService()
        service.isConnected = true

        var capturedParams: JSONValue?
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/start")
            capturedParams = params
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-trimmed-subagents")]),
                includeJSONRPC: false
            )
        }

        let viewModel = TurnViewModel()
        viewModel.input = "   follow up"
        viewModel.isSubagentsSelectionArmed = true

        viewModel.sendTurn(codex: service, threadID: "thread-trimmed-subagents")
        await waitForSendCompletion(viewModel)

        XCTAssertEqual(
            textInput(from: capturedParams),
            "Run subagents for different tasks. Delegate distinct work in parallel when helpful and then synthesize the results.\n\nfollow up"
        )
    }

    func testSendTurnPrefixesPromptAfterFileMentionRewrite() async {
        let service = makeService()
        service.isConnected = true

        var capturedParams: JSONValue?
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/start")
            capturedParams = params
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-file-mention-subagents")]),
                includeJSONRPC: false
            )
        }

        let viewModel = TurnViewModel()
        viewModel.input = "@TurnView.swift /sub"
        viewModel.composerMentionedFiles = [
            TurnComposerMentionedFile(
                fileName: "TurnView.swift",
                path: "Views/Turn/TurnView.swift"
            )
        ]
        viewModel.slashCommandPanelState = .commands(query: "sub")
        viewModel.onSelectSlashCommand(.subagents)

        viewModel.sendTurn(codex: service, threadID: "thread-file-mention-subagents")
        await waitForSendCompletion(viewModel)

        XCTAssertEqual(
            textInput(from: capturedParams),
            "Run subagents for different tasks. Delegate distinct work in parallel when helpful and then synthesize the results.\n\n@Views/Turn/TurnView.swift"
        )
    }
}
