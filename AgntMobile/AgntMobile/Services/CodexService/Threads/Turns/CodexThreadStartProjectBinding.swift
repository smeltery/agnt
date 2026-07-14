// FILE: CodexThreadStartProjectBinding.swift
// Purpose: Thread start request project binding helpers.
// Layer: Service

import Foundation

enum CodexThreadStartProjectBinding {
    // Normalizes project paths before sending them to thread/start.
    static func normalizedProjectPath(_ rawValue: String?) -> String? {
        CodexThread.normalizedFilesystemProjectPath(rawValue)
    }

    static func makeThreadStartParams(
        modelIdentifier: String?,
        preferredProjectPath: String?,
        serviceTier: String?
    ) -> RPCObject {
        var params: RPCObject = [:]

        if let modelIdentifier {
            params["model"] = .string(modelIdentifier)
        }

        if let preferredProjectPath {
            params["cwd"] = .string(preferredProjectPath)
        }

        if let serviceTier {
            params["serviceTier"] = .string(serviceTier)
        }

        return params
    }

    // Preserves project grouping even when older servers omit cwd in thread/start result.
    static func applyPreferredProjectFallback(to thread: CodexThread, preferredProjectPath: String?) -> CodexThread {
        guard thread.normalizedProjectPath == nil,
              let preferredProjectPath else {
            return thread
        }

        var patchedThread = thread
        patchedThread.cwd = preferredProjectPath
        return patchedThread
    }
}
