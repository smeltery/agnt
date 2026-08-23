// FILE: BridgeControlService.swift
// Purpose: Wraps the existing agnt/npm shell commands so the menu bar app can detect the global CLI and control the bridge.
// Layer: Companion app service
// Exports: BridgeControlService
// Depends on: Foundation, BridgeControlModels, BridgeControlShell, BridgeControlTrustFallback

import Foundation

final class BridgeControlService {
    private let runner: ShellCommandRunner
    private let decoder = JSONDecoder()
    private let fileManager = FileManager.default
    private let defaultStateDirectory = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent(".agnt", isDirectory: true)
    private let launchAgentPlistURL = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent("Library", isDirectory: true)
        .appendingPathComponent("LaunchAgents", isDirectory: true)
        .appendingPathComponent("com.smeltery.agnt.bridge.plist")

    init(runner: ShellCommandRunner = ShellCommandRunner()) {
        self.runner = runner
    }

    // Confirms the product contract for this companion: a global `agnt` CLI must be runnable first.
    func detectCLIAvailability() async -> BridgeCLIAvailability {
        do {
            let invocation = try await resolveCLIInvocation()
            let result = try await runner.run(command: invocation.command(["--version"]))
            guard let version = parseLatestVersion(result.stdout) else {
                return .broken(message: "The installed CLI returned an unreadable version.")
            }

            return .available(version: version)
        } catch {
            return classifyCLIAvailability(from: error)
        }
    }

    // Loads the daemon snapshot from the CLI so the menu bar stays aligned with the package's real control plane.
    func loadSnapshot(relayOverride: String?) async throws -> BridgeSnapshot {
        let invocation = try await resolveCLIInvocation()
        let result = try await runner.run(
            command: invocation.command(["status", "--json"]),
            environment: commandEnvironment(relayOverride: relayOverride)
        )
        guard let data = result.stdout.data(using: .utf8) else {
            throw BridgeControlError.invalidSnapshot("Bridge status returned invalid UTF-8.")
        }

        do {
            let snapshot = try decoder.decode(BridgeSnapshot.self, from: data)
            return snapshotWithLocalTrustFallback(snapshot)
        } catch {
            return try await loadFallbackSnapshot(from: result.stdout, invocation: invocation)
        }
    }

    func startBridge(relayOverride: String?) async throws {
        let invocation = try await resolveCLIInvocation()
        _ = try await runner.run(
            command: invocation.command(["start"]),
            environment: commandEnvironment(relayOverride: relayOverride)
        )
    }

    func restartBridge(relayOverride: String?) async throws {
        let invocation = try await resolveCLIInvocation()
        _ = try await runner.run(
            command: invocation.command(["restart"]),
            environment: commandEnvironment(relayOverride: relayOverride)
        )
    }

    func stopBridge(relayOverride: String?) async throws {
        let invocation = try await resolveCLIInvocation()
        _ = try await runner.run(
            command: invocation.command(["stop"]),
            environment: commandEnvironment(relayOverride: relayOverride)
        )
    }

    func refreshPairing(relayOverride: String?) async throws {
        let invocation = try await resolveCLIInvocation()
        _ = try await runner.run(
            command: invocation.command(["pair", "--json"]),
            environment: commandEnvironment(relayOverride: relayOverride)
        )
    }

    func resumeLastThread(relayOverride: String?) async throws {
        let invocation = try await resolveCLIInvocation()
        _ = try await runner.run(
            command: invocation.command(["resume"]),
            environment: commandEnvironment(relayOverride: relayOverride)
        )
    }

    func resetPairing(relayOverride: String?) async throws {
        let invocation = try await resolveCLIInvocation()
        _ = try await runner.run(
            command: invocation.command(["reset-pairing"]),
            environment: commandEnvironment(relayOverride: relayOverride)
        )
    }

    func updateBridgePackage() async throws {
        _ = try await runner.run(command: "npm install -g @smeltery/agnt@latest")
    }

    func fetchLatestPackageVersion() async -> Result<String, Error> {
        do {
            let result = try await runner.run(command: "npm view @smeltery/agnt version --json")
            let latestVersion = parseLatestVersion(result.stdout)
            guard let latestVersion else {
                throw BridgeControlError.commandFailed(
                    command: "npm view @smeltery/agnt version --json",
                    message: "npm returned an unreadable version."
                )
            }
            return .success(latestVersion)
        } catch {
            return .failure(error)
        }
    }

    private func parseLatestVersion(_ output: String) -> String? {
        guard !output.isEmpty else {
            return nil
        }

        if let data = output.data(using: .utf8),
           let stringValue = try? decoder.decode(String.self, from: data),
           !stringValue.isEmpty {
            return stringValue
        }

        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // Falls back to the daemon-state files when the global CLI still prints human-readable status output.
    private func loadFallbackSnapshot(
        from statusOutput: String,
        invocation: BridgeCLIInvocation
    ) async throws -> BridgeSnapshot {
        let statusLines = parseStatusLines(statusOutput)
        guard !statusLines.isEmpty else {
            throw BridgeControlError.invalidSnapshot("Bridge status returned malformed JSON.")
        }

        let versionResult = try await runner.run(command: invocation.command(["--version"]))
        guard let currentVersion = parseLatestVersion(versionResult.stdout) else {
            throw BridgeControlError.invalidSnapshot("Bridge status returned an unreadable CLI version.")
        }

        let stateDirectory = resolveStateDirectory(statusLines: statusLines)
        let daemonConfig: BridgeDaemonConfig? = readStateFile(named: "daemon-config.json", in: stateDirectory)
        let bridgeStatus: BridgeRuntimeStatus? = readStateFile(named: "bridge-status.json", in: stateDirectory)
        let pairingSession: BridgePairingSession? = readStateFile(named: "pairing-session.json", in: stateDirectory)
        let trustedDevice: BridgeTrustedDeviceSummary? = readDeviceTrustSummary(in: stateDirectory)
        let stdoutLogPath = statusLines["stdout log"] ?? stateDirectory.appendingPathComponent("logs/bridge.stdout.log").path
        let stderrLogPath = statusLines["stderr log"] ?? stateDirectory.appendingPathComponent("logs/bridge.stderr.log").path
        let launchdPid = parsePid(statusLines["pid"])
        let launchdLoaded = parseYesNo(statusLines["launchd loaded"]) ?? false
        let installed = parseYesNo(statusLines["installed"]) ?? fileManager.fileExists(atPath: launchAgentPlistURL.path)

        return BridgeSnapshot(
            currentVersion: currentVersion,
            label: statusLines["service label"] ?? "com.smeltery.agnt.bridge",
            platform: "darwin",
            installed: installed,
            launchdLoaded: launchdLoaded,
            launchdPid: launchdPid,
            daemonConfig: daemonConfig,
            bridgeStatus: bridgeStatus,
            pairingSession: pairingSession,
            trustedDevice: trustedDevice,
            stdoutLogPath: stdoutLogPath,
            stderrLogPath: stderrLogPath
        )
    }

    private func snapshotWithLocalTrustFallback(_ snapshot: BridgeSnapshot) -> BridgeSnapshot {
        guard snapshot.trustedDevice == nil else {
            return snapshot
        }

        let stateDirectory = URL(fileURLWithPath: snapshot.stateDirectoryPath)
        guard let trustedDevice = readDeviceTrustSummary(in: stateDirectory) else {
            return snapshot
        }

        return BridgeSnapshot(
            currentVersion: snapshot.currentVersion,
            label: snapshot.label,
            platform: snapshot.platform,
            installed: snapshot.installed,
            launchdLoaded: snapshot.launchdLoaded,
            launchdPid: snapshot.launchdPid,
            daemonConfig: snapshot.daemonConfig,
            bridgeStatus: snapshot.bridgeStatus,
            pairingSession: snapshot.pairingSession,
            trustedDevice: trustedDevice,
            stdoutLogPath: snapshot.stdoutLogPath,
            stderrLogPath: snapshot.stderrLogPath
        )
    }

    // Resolves both the CLI script and the Node runtime from stable absolute paths before the menu bar invokes them.
    private func resolveCLIInvocation() async throws -> BridgeCLIInvocation {
        let agntPath = try await resolveExecutable(named: "agnt")
        let nodePath = try await resolveNodePath(for: agntPath)
        return BridgeCLIInvocation(nodePath: nodePath, agntPath: agntPath)
    }

    private func parseStatusLines(_ output: String) -> [String: String] {
        output
            .split(separator: "\n", omittingEmptySubsequences: true)
            .reduce(into: [String: String]()) { partialResult, line in
                let cleaned = line.trimmingCharacters(in: .whitespacesAndNewlines)
                let prefix = "[agnt] "
                guard cleaned.hasPrefix(prefix) else {
                    return
                }

                let payload = cleaned.dropFirst(prefix.count)
                guard let separatorIndex = payload.firstIndex(of: ":") else {
                    return
                }

                let key = payload[..<separatorIndex]
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .lowercased()
                let value = payload[payload.index(after: separatorIndex)...]
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                partialResult[key] = value
            }
    }

    private func parseYesNo(_ value: String?) -> Bool? {
        switch value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "yes":
            return true
        case "no":
            return false
        default:
            return nil
        }
    }

    private func parsePid(_ value: String?) -> Int? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              let pid = Int(value) else {
            return nil
        }

        return pid
    }

    // Reads daemon-state files from the same state root used by the bridge service.
    private func readStateFile<T: Decodable>(named filename: String, in stateDirectory: URL) -> T? {
        let targetURL = stateDirectory.appendingPathComponent(filename)
        guard let data = try? Data(contentsOf: targetURL) else {
            return nil
        }

        return try? decoder.decode(T.self, from: data)
    }

    private func readDeviceTrustSummary(in stateDirectory: URL) -> BridgeTrustedDeviceSummary? {
        guard let state: LegacyBridgeDeviceState = readStateFile(named: "device-state.json", in: stateDirectory) else {
            return nil
        }

        let trustedPhones = state.trustedPhones.filter { key, value in
            !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        let firstTrustedPhoneId = trustedPhones.keys.sorted().first
        let lastSeenPhoneAppVersion = normalizeNonEmptyString(state.lastSeenPhoneAppVersion)
        return BridgeTrustedDeviceSummary(
            macDeviceFingerprint: shortFingerprint(state.macDeviceId),
            trustedPhoneCount: trustedPhones.count,
            trustedPhoneFingerprint: shortFingerprint(firstTrustedPhoneId),
            lastSeenDeviceKind: normalizeDeviceKind(state.lastSeenDeviceKind) ?? (lastSeenPhoneAppVersion == nil ? nil : "iphone"),
            lastSeenPhoneAppVersion: lastSeenPhoneAppVersion
        )
    }

    // Prefers the Node runtime sitting next to the resolved CLI binary so mixed installs stay compatible.
    private func resolveNodePath(for agntPath: String) async throws -> String {
        if let colocatedNodePath = resolveColocatedNodePath(for: agntPath) {
            return colocatedNodePath
        }

        return try await resolveExecutable(named: "node")
    }

    private func resolveColocatedNodePath(for agntPath: String) -> String? {
        let agntURL = URL(fileURLWithPath: agntPath)
        let candidateDirectories = [
            agntURL.deletingLastPathComponent().path,
            agntURL.resolvingSymlinksInPath().deletingLastPathComponent().path,
        ]

        var seenDirectories = Set<String>()
        for directory in candidateDirectories where seenDirectories.insert(directory).inserted {
            let candidate = URL(fileURLWithPath: directory, isDirectory: true)
                .appendingPathComponent("node")
                .path
            if fileManager.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }

        return nil
    }

    private func resolveExecutable(named name: String) async throws -> String {
        if let discovered = try? await runner.run(command: "command -v \(name)"),
           let path = parseExecutablePath(discovered.stdout),
           fileManager.isExecutableFile(atPath: path) {
            return path
        }

        if let fallback = fallbackExecutableCandidates(named: name).first(where: { fileManager.isExecutableFile(atPath: $0) }) {
            return fallback
        }

        throw BridgeControlError.commandFailed(
            command: name,
            message: "\(name) was not found in the app shell environment."
        )
    }

    private func parseExecutablePath(_ output: String) -> String? {
        let path = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return path.isEmpty ? nil : path
    }

    private func fallbackExecutableCandidates(named name: String) -> [String] {
        let homeDirectory = NSHomeDirectory()
        let stableCandidates = [
            "/opt/homebrew/bin/\(name)",
            "/usr/local/bin/\(name)",
            "\(homeDirectory)/.local/bin/\(name)",
            "\(homeDirectory)/.volta/bin/\(name)",
        ]

        return stableCandidates + nvmExecutableCandidates(named: name, homeDirectory: homeDirectory)
    }

    private func nvmExecutableCandidates(named name: String, homeDirectory: String) -> [String] {
        let versionsDirectory = URL(fileURLWithPath: homeDirectory)
            .appendingPathComponent(".nvm", isDirectory: true)
            .appendingPathComponent("versions", isDirectory: true)
            .appendingPathComponent("node", isDirectory: true)

        guard let contents = try? fileManager.contentsOfDirectory(
            at: versionsDirectory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        return contents
            .sorted { compareVersionDirectoryNames($0.lastPathComponent, $1.lastPathComponent) == .orderedDescending }
            .map { $0.appendingPathComponent("bin", isDirectory: true).appendingPathComponent(name).path }
    }

    // Mirrors the bridge daemon-state lookup order so CLI output hydrates the companion correctly.
    private func resolveStateDirectory(statusLines: [String: String]) -> URL {
        if let explicitStateDirectory = normalizeNonEmptyString(ProcessInfo.processInfo.environment["AGNT_DEVICE_STATE_DIR"]) {
            return URL(fileURLWithPath: explicitStateDirectory, isDirectory: true)
        }

        if let installedStateDirectory = readLaunchAgentStateDirectory() {
            return installedStateDirectory
        }

        if let derivedStateDirectory = deriveStateDirectory(fromLogPath: statusLines["stdout log"] ?? statusLines["stderr log"]) {
            return derivedStateDirectory
        }

        return defaultStateDirectory
    }

    private func readLaunchAgentStateDirectory() -> URL? {
        guard let data = try? Data(contentsOf: launchAgentPlistURL),
              let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
              let environment = plist["EnvironmentVariables"] as? [String: Any],
              let stateDirectory = normalizeNonEmptyString(environment["AGNT_DEVICE_STATE_DIR"] as? String) else {
            return nil
        }

        return URL(fileURLWithPath: stateDirectory, isDirectory: true)
    }

    private func deriveStateDirectory(fromLogPath logPath: String?) -> URL? {
        guard let logPath = normalizeNonEmptyString(logPath) else {
            return nil
        }

        return URL(fileURLWithPath: logPath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private func compareVersionDirectoryNames(_ lhs: String, _ rhs: String) -> ComparisonResult {
        let lhsVersion = parseVersionDirectoryName(lhs)
        let rhsVersion = parseVersionDirectoryName(rhs)

        switch (lhsVersion, rhsVersion) {
        case let (.some(lhsVersion), .some(rhsVersion)):
            return compareVersionComponents(lhsVersion, rhsVersion)
        case (.some, .none):
            return .orderedDescending
        case (.none, .some):
            return .orderedAscending
        case (.none, .none):
            return lhs.localizedStandardCompare(rhs)
        }
    }

    private func parseVersionDirectoryName(_ value: String) -> [Int]? {
        let normalized = value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "v", with: "", options: [.anchored])
        let coreVersion = normalized.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: true).first
        guard let coreVersion else {
            return nil
        }

        let parts = coreVersion.split(separator: ".", omittingEmptySubsequences: false)
        guard !parts.isEmpty else {
            return nil
        }

        let numericParts = parts.compactMap { Int($0) }
        guard numericParts.count == parts.count else {
            return nil
        }

        return numericParts
    }

    private func compareVersionComponents(_ lhs: [Int], _ rhs: [Int]) -> ComparisonResult {
        for index in 0..<max(lhs.count, rhs.count) {
            let lhsValue = index < lhs.count ? lhs[index] : 0
            let rhsValue = index < rhs.count ? rhs[index] : 0

            if lhsValue == rhsValue {
                continue
            }

            return lhsValue < rhsValue ? .orderedAscending : .orderedDescending
        }

        return .orderedSame
    }

    private func normalizeNonEmptyString(_ value: String?) -> String? {
        guard let value else {
            return nil
        }

        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // Maps shell failures into the explicit "missing global CLI" state shown by the menu bar.
    private func classifyCLIAvailability(from error: Error) -> BridgeCLIAvailability {
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = message.lowercased()

        if normalized.contains("command not found: agnt")
            || normalized.contains("agnt: command not found")
            || normalized.contains("agnt: not found")
            || normalized.contains("no such file or directory") {
            return .missing
        }

        return .broken(message: message.isEmpty ? "The CLI returned an unknown error." : message)
    }

    private func commandEnvironment(relayOverride: String?) -> [String: String] {
        guard let relayOverride,
              !relayOverride.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return [:]
        }

        return [
            "AGNT_RELAY": relayOverride.trimmingCharacters(in: .whitespacesAndNewlines),
        ]
    }
}
