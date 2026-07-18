// FILE: BridgeControlShell.swift
// Purpose: Runs shell commands for the menu bar bridge control service.
// Layer: Companion app service
// Exports: BridgeCLIInvocation, ShellCommandRunner, ShellCommandResult, BridgeControlError
// Depends on: Foundation

import Foundation

struct BridgeCLIInvocation {
    let nodePath: String
    let agntPath: String

    // Executes the actual CLI entrypoint via an absolute Node binary so GUI PATH drift does not break nvm installs.
    func command(_ arguments: [String]) -> String {
        ([shellQuoted(nodePath), shellQuoted(agntPath)] + arguments).joined(separator: " ")
    }
}

struct ShellCommandResult {
    let stdout: String
    let stderr: String
    let exitCode: Int32
}

enum BridgeControlError: LocalizedError {
    case commandFailed(command: String, message: String)
    case invalidSnapshot(String)

    var errorDescription: String? {
        switch self {
        case .commandFailed(_, let message):
            return message
        case .invalidSnapshot(let message):
            return message
        }
    }
}

final class ShellCommandRunner {
    // Runs a login shell so Homebrew, nvm, asdf, and other user PATH customizations resolve naturally.
    func run(command: String, environment: [String: String] = [:]) async throws -> ShellCommandResult {
        try await Task.detached(priority: .userInitiated) {
            let process = Process()
            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            let stdoutReader = Task.detached(priority: .userInitiated) {
                stdoutPipe.fileHandleForReading.readDataToEndOfFile()
            }
            let stderrReader = Task.detached(priority: .userInitiated) {
                stderrPipe.fileHandleForReading.readDataToEndOfFile()
            }

            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            process.arguments = ["-lc", self.wrappedShellCommand(command)]
            process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
            process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, override in
                override
            }
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe

            try process.run()
            process.waitUntilExit()

            let stdout = String(data: await stdoutReader.value, encoding: .utf8) ?? ""
            let stderr = String(data: await stderrReader.value, encoding: .utf8) ?? ""
            let result = ShellCommandResult(
                stdout: stdout.trimmingCharacters(in: .whitespacesAndNewlines),
                stderr: stderr.trimmingCharacters(in: .whitespacesAndNewlines),
                exitCode: process.terminationStatus
            )

            guard result.exitCode == 0 else {
                let message = result.stderr.isEmpty ? result.stdout : result.stderr
                throw BridgeControlError.commandFailed(
                    command: command,
                    message: message.isEmpty ? "Command failed: \(command)" : message
                )
            }

            return result
        }.value
    }

    // Silently loads interactive zsh PATH customizations so GUI-launched commands see the same global CLI install as Terminal.
    private func wrappedShellCommand(_ command: String) -> String {
        [
            "export TERM=dumb",
            "source ~/.zshrc >/dev/null 2>/dev/null || true",
            command,
        ].joined(separator: "; ")
    }
}

private func shellQuoted(_ value: String) -> String {
    "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
}
