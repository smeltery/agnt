// FILE: CommandExecutionCardBody.swift
// Purpose: Compact inline command execution row and command humanizer.
// Layer: View Components

import SwiftUI

// MARK: - Card Body

struct CommandExecutionCardBody: View {
    let command: String
    let statusLabel: String
    let accent: CommandExecutionStatusAccent

    // Cached at struct level — humanize() does string parsing so we avoid
    // re-running it on every body evaluation during streaming updates.
    private static let humanizeCache = BoundedCache<String, CommandHumanizer.Info>(maxEntries: 128)

    private var display: CommandHumanizer.Info {
        let key = "\(command)|\(accent == .running)"
        if let cached = Self.humanizeCache.get(key) { return cached }
        let info = CommandHumanizer.humanize(command, isRunning: accent == .running)
        Self.humanizeCache.set(key, value: info)
        return info
    }

    private var leadingAssetName: String? {
        CommandHumanizer.leadingAssetName(for: command)
    }

    var body: some View {
        HStack(spacing: leadingAssetName == nil ? 0 : 6) {
            if let leadingAssetName {
                Image(leadingAssetName)
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 14, height: 14)
                    .foregroundStyle(.secondary)
            }

            (
                Text(display.verb)
                    .font(AppFont.subheadline(weight: .medium))
                    .foregroundStyle(.secondary)
                +
                Text(" " + display.target)
                    .font(AppFont.subheadline())
                    .foregroundStyle(.tertiary)
            )
            .lineLimit(1)
            .truncationMode(.tail)

            Spacer(minLength: 6)

            // Running/completed state is already conveyed by the verb tense.
            if accent == .failed {
                Image(systemName: "exclamationmark.circle.fill")
                    .font(AppFont.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.red)
            }

            Image(systemName: "chevron.right")
                .font(AppFont.system(size: 8, weight: .semibold))
                .foregroundStyle(.quaternary)
                .padding(.leading, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Tool rows update often while commands stream; keep the subtree static to avoid whole-row flashing.
        .transaction { transaction in
            transaction.animation = nil
        }
    }
}

// MARK: - Command Humanizer

/// Translates raw CLI commands into human-readable labels for the timeline.
/// The full command is still available in the detail sheet on tap.
enum CommandHumanizer {
    struct Info {
        let verb: String
        let target: String
    }

    static func humanize(_ raw: String, isRunning: Bool) -> Info {
        let command = unwrapShell(raw)
        let (tool, args) = splitToolAndArgs(command)

        switch tool {
        case "cat", "nl", "head", "tail", "sed", "less", "more":
            return Info(
                verb: isRunning ? "Reading" : "Read",
                target: lastPathComponents(from: args, fallback: "file")
            )
        case "rg", "grep", "ag", "ack":
            return Info(
                verb: isRunning ? "Searching" : "Searched",
                target: searchSummary(from: args)
            )
        case "ls":
            return Info(
                verb: isRunning ? "Listing" : "Listed",
                target: lastPathComponents(from: args, fallback: "directory")
            )
        case "find", "fd":
            return Info(
                verb: isRunning ? "Finding" : "Found",
                target: lastPathComponents(from: args, fallback: "files")
            )
        case "mkdir":
            return Info(
                verb: isRunning ? "Creating" : "Created",
                target: lastPathComponents(from: args, fallback: "directory")
            )
        case "rm":
            return Info(
                verb: isRunning ? "Removing" : "Removed",
                target: lastPathComponents(from: args, fallback: "file")
            )
        case "cp", "mv":
            return Info(
                verb: isRunning ? (tool == "cp" ? "Copying" : "Moving") : (tool == "cp" ? "Copied" : "Moved"),
                target: lastPathComponents(from: args, fallback: "file")
            )
        case "git":
            return gitInfo(args, isRunning: isRunning)
        default:
            return Info(
                verb: isRunning ? "Running" : "Ran",
                target: command
            )
        }
    }

    static func leadingAssetName(for raw: String) -> String? {
        let command = unwrapShell(raw)
        let (tool, _) = splitToolAndArgs(command)

        switch tool {
        case "gh", "github":
            return "GitHub_Invertocat_Black"
        default:
            return nil
        }
    }

    // MARK: - Shell unwrapping

    /// Strips `bash -lc "cd /path && real_command"` wrappers and pipeline
    /// suffixes to surface the primary command for humanization.
    private static func unwrapShell(_ raw: String) -> String {
        var result = raw.trimmingCharacters(in: .whitespacesAndNewlines)

        // Match common shell wrapper patterns: bash/sh with -c or -lc
        let lowered = result.lowercased()
        let shellPrefixes = [
            "/usr/bin/bash -lc ", "/usr/bin/bash -c ",
            "/bin/bash -lc ", "/bin/bash -c ",
            "bash -lc ", "bash -c ",
            "/bin/sh -c ", "sh -c ",
        ]

        for prefix in shellPrefixes {
            guard lowered.hasPrefix(prefix) else { continue }
            result = String(result.dropFirst(prefix.count))
            // Strip surrounding quotes
            if (result.hasPrefix("\"") && result.hasSuffix("\""))
                || (result.hasPrefix("'") && result.hasSuffix("'")) {
                result = String(result.dropFirst().dropLast())
            }
            // Strip `cd //path &&` prefix
            if let andIndex = result.range(of: "&&") {
                result = String(result[andIndex.upperBound...]).trimmingCharacters(in: .whitespaces)
            }
            break
        }

        // Pipeline: take the first command only.
        // `nl -ba File.tsx | sed -n '220,240p'` → `nl -ba File.tsx`
        // The downstream commands are output filters, not meaningful for the label.
        if let pipeIndex = result.range(of: " | ") {
            result = String(result[result.startIndex..<pipeIndex.lowerBound]).trimmingCharacters(in: .whitespaces)
        }

        return result
    }

    // MARK: - Parsing helpers

    private static func splitToolAndArgs(_ command: String) -> (tool: String, args: String) {
        let parts = command.split(separator: " ", maxSplits: 1)
        let rawTool = parts.first.map(String.init) ?? command
        // Resolve full paths like /usr/bin/nl → nl
        let tool = (rawTool as NSString).lastPathComponent.lowercased()
        let args = parts.count > 1 ? String(parts[1]) : ""
        return (tool, args)
    }

    /// Extracts the last meaningful file path from args, skipping flags.
    private static func lastPathComponents(from args: String, fallback: String) -> String {
        // Walk args in reverse to find the last non-flag token (typically the path).
        let tokens = args.split(separator: " ")
        for token in tokens.reversed() {
            let s = String(token).trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            guard !s.isEmpty, !s.hasPrefix("-") else { continue }
            return compactPath(s)
        }
        return fallback
    }

    /// Keeps the last two path components for readability: `a/b/c/d.swift` → `c/d.swift`.
    private static func compactPath(_ path: String) -> String {
        let components = path.split(separator: "/").map(String.init)
        guard components.count > 2 else { return path }
        return components.suffix(2).joined(separator: "/")
    }

    /// Builds a compact search description: `rg -n "pattern" path` → `for pattern in path`.
    /// Handles quoted patterns that contain spaces and special characters.
    private static func searchSummary(from args: String) -> String {
        let (pattern, path) = extractSearchPatternAndPath(from: args)
        let displayPattern = pattern ?? "..."
        if let path {
            return "for \(displayPattern) in \(path)"
        }
        return "for \(displayPattern)"
    }

    /// Splits search args into (pattern, path) respecting quoted strings.
    /// `rg -n "project.model \|\| FOO" src/` → ("project.model...", "src/")
    private static func extractSearchPatternAndPath(from args: String) -> (pattern: String?, path: String?) {
        let chars = Array(args)
        var tokens: [String] = []
        var i = 0

        while i < chars.count {
            // Skip whitespace
            while i < chars.count, chars[i] == " " { i += 1 }
            guard i < chars.count else { break }

            if chars[i] == "\"" || chars[i] == "'" {
                // Quoted token — collect until matching close quote
                let quote = chars[i]
                i += 1
                var buf = ""
                while i < chars.count, chars[i] != quote {
                    if chars[i] == "\\" && i + 1 < chars.count { buf.append(chars[i + 1]); i += 2 }
                    else { buf.append(chars[i]); i += 1 }
                }
                if i < chars.count { i += 1 } // skip closing quote
                tokens.append(buf)
            } else {
                // Unquoted token
                var buf = ""
                while i < chars.count, chars[i] != " " { buf.append(chars[i]); i += 1 }
                tokens.append(buf)
            }
        }

        // Walk tokens: skip flags, first positional = pattern, second = path
        var pattern: String?
        var path: String?
        var skipNext = false

        for token in tokens {
            if skipNext { skipNext = false; continue }
            if token.hasPrefix("-") {
                if token == "-t" || token == "-g" || token == "--type" || token == "--glob" || token == "--max-count" {
                    skipNext = true
                }
                continue
            }
            if pattern == nil {
                // Truncate very long regex patterns for readability
                pattern = token.count > 30 ? String(token.prefix(27)) + "..." : token
            } else if path == nil {
                path = compactPath(token)
            }
        }

        return (pattern, path)
    }

    // MARK: - Git

    private static func gitInfo(_ args: String, isRunning: Bool) -> Info {
        let parts = args.split(separator: " ", maxSplits: 1)
        let sub = parts.first.map(String.init) ?? ""

        switch sub {
        case "status": return Info(verb: isRunning ? "Checking" : "Checked", target: "git status")
        case "diff":   return Info(verb: isRunning ? "Comparing" : "Compared", target: "changes")
        case "log":    return Info(verb: isRunning ? "Viewing" : "Viewed", target: "git log")
        case "add":    return Info(verb: isRunning ? "Staging" : "Staged", target: "changes")
        case "commit": return Info(verb: isRunning ? "Committing" : "Committed", target: "changes")
        case "push":   return Info(verb: isRunning ? "Pushing" : "Pushed", target: "to remote")
        case "pull":   return Info(verb: isRunning ? "Pulling" : "Pulled", target: "from remote")
        case "checkout", "switch":
            let branch = parts.count > 1
                ? String(parts[1]).split(separator: " ").last.map(String.init) ?? ""
                : ""
            return Info(verb: isRunning ? "Switching to" : "Switched to", target: branch.isEmpty ? "branch" : branch)
        default:
            return Info(verb: isRunning ? "Running" : "Ran", target: "git " + args)
        }
    }
}
