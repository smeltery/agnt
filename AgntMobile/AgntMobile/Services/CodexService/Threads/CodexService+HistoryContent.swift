// FILE: CodexService+HistoryContent.swift
// Purpose: Decodes history timestamps, text content, and structured mentions.
// Layer: Service Extension
// Exports: CodexService history content decoding helpers
// Depends on: Foundation, JSONValue, CodexTimestampParser

import Foundation

extension CodexService {
    func decodeHistoryBaseDate(from threadObject: [String: JSONValue], threadId: String? = nil) -> Date {
        if let rawCreatedAt = threadObject["createdAt"]?.doubleValue {
            if let date = trustedHistoryDate(CodexTimestampParser.decodeUnixTimestamp(rawCreatedAt)) {
                return date
            }
        }
        if let rawCreatedAt = threadObject["created_at"]?.doubleValue {
            if let date = trustedHistoryDate(CodexTimestampParser.decodeUnixTimestamp(rawCreatedAt)) {
                return date
            }
        }

        if let rawUpdatedAt = threadObject["updatedAt"]?.doubleValue {
            if let date = trustedHistoryDate(CodexTimestampParser.decodeUnixTimestamp(rawUpdatedAt)) {
                return date
            }
        }
        if let rawUpdatedAt = threadObject["updated_at"]?.doubleValue {
            if let date = trustedHistoryDate(CodexTimestampParser.decodeUnixTimestamp(rawUpdatedAt)) {
                return date
            }
        }

        if let rawCreatedAt = threadObject["createdAt"]?.stringValue,
           let parsed = trustedHistoryDate(CodexTimestampParser.parseString(rawCreatedAt)) {
            return parsed
        }
        if let rawCreatedAt = threadObject["created_at"]?.stringValue,
           let parsed = trustedHistoryDate(CodexTimestampParser.parseString(rawCreatedAt)) {
            return parsed
        }

        if let rawUpdatedAt = threadObject["updatedAt"]?.stringValue,
           let parsed = trustedHistoryDate(CodexTimestampParser.parseString(rawUpdatedAt)) {
            return parsed
        }
        if let rawUpdatedAt = threadObject["updated_at"]?.stringValue,
           let parsed = trustedHistoryDate(CodexTimestampParser.parseString(rawUpdatedAt)) {
            return parsed
        }

        if let threadId,
           let localAnchor = existingHistoryFallbackDate(for: threadId) {
            return localAnchor
        }

        // Use a current local anchor rather than epoch, which renders as 1:00 in CET.
        return Date()
    }

    func decodeUnixTimestamp(_ rawValue: Double) -> Date {
        CodexTimestampParser.decodeUnixTimestamp(rawValue)
    }

    func decodeItemText(from itemObject: [String: JSONValue]) -> String {
        let contentItems = itemObject["content"]?.arrayValue ?? []

        let textParts = contentItems.compactMap { value -> String? in
            guard let object = value.objectValue else { return nil }
            let inputType = normalizedItemType(object["type"]?.stringValue?.lowercased() ?? "")

            if inputType == "text", let text = object["text"]?.stringValue {
                return text
            }

            if inputType == "inputtext" || inputType == "outputtext" || inputType == "message",
               let text = object["text"]?.stringValue {
                return text
            }

            if inputType == "skill" {
                let skillID = object["id"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
                let skillName = object["name"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
                let resolved = (skillID?.isEmpty == false) ? skillID : skillName
                if let resolved, !resolved.isEmpty {
                    return "$\(resolved)"
                }
            }

            if inputType == "mention" {
                let resolved = firstNonEmptyString([
                    object["name"]?.stringValue,
                    object["id"]?.stringValue,
                    object["path"]?.stringValue,
                ])
                if let resolved, !resolved.isEmpty {
                    return "@\(resolved)"
                }
            }

            if inputType == "text",
               let dataText = object["data"]?.objectValue?["text"]?.stringValue {
                return dataText
            }

            return nil
        }

        let joined = textParts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if !joined.isEmpty {
            return joined
        }

        if let directText = itemObject["text"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
           !directText.isEmpty {
            return directText
        }

        if let nestedText = itemObject["message"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
           !nestedText.isEmpty {
            return nestedText
        }

        return ""
    }

    func decodeHistorySkillMentions(from itemObject: [String: JSONValue]) -> [String] {
        let contentItems = itemObject["content"]?.arrayValue ?? []
        var mentions: [String] = []
        var seen: Set<String> = []

        for value in contentItems {
            guard let object = value.objectValue else { continue }
            let inputType = normalizedItemType(object["type"]?.stringValue?.lowercased() ?? "")
            guard inputType == "skill" else { continue }

            let rawSkill = firstNonEmptyString([
                object["id"]?.stringValue,
                object["name"]?.stringValue,
            ])
            guard let rawSkill else { continue }

            let mention = rawSkill.trimmingCharacters(in: .whitespacesAndNewlines)
            let normalized = Self.normalizedUserMentionName(mention)
            guard !mention.isEmpty, !seen.contains(normalized) else { continue }
            seen.insert(normalized)
            mentions.append(mention)
        }

        return mentions
    }

    func decodeHistoryPluginMentions(from itemObject: [String: JSONValue]) -> [String] {
        let contentItems = itemObject["content"]?.arrayValue ?? []
        var mentions: [String] = []
        var seen: Set<String> = []

        for value in contentItems {
            guard let object = value.objectValue else { continue }
            let inputType = normalizedItemType(object["type"]?.stringValue?.lowercased() ?? "")
            guard inputType == "mention" else { continue }

            let rawMention = firstNonEmptyString([
                object["name"]?.stringValue,
                object["id"]?.stringValue,
                object["path"]?.stringValue,
            ])
            guard let rawMention else { continue }

            let mention = rawMention.trimmingCharacters(in: .whitespacesAndNewlines)
            let normalized = Self.normalizedUserMentionName(mention)
            guard !mention.isEmpty, !seen.contains(normalized) else { continue }
            seen.insert(normalized)
            mentions.append(mention)
        }

        return mentions
    }

    func decodeHistoryTimestamp(from object: [String: JSONValue]) -> Date? {
        let numericKeys = [
            "createdAt",
            "created_at",
            "startedAt",
            "started_at",
            "completedAt",
            "completed_at",
            "endedAt",
            "ended_at",
            "timestamp",
            "time",
            "updatedAt",
            "updated_at",
        ]

        for key in numericKeys {
            if let value = object[key]?.doubleValue {
                if let date = trustedHistoryDate(CodexTimestampParser.decodeUnixTimestamp(value)) {
                    return date
                }
            }
            if let value = object[key]?.intValue {
                if let date = trustedHistoryDate(CodexTimestampParser.decodeUnixTimestamp(Double(value))) {
                    return date
                }
            }
            if let value = object[key]?.stringValue {
                if let parsed = trustedHistoryDate(CodexTimestampParser.parseString(value)) {
                    return parsed
                }
            }
        }

        return nil
    }

    func decodeHistoryTimeZoneIdentifier(from object: [String: JSONValue]) -> String? {
        for key in ["timeZoneIdentifier", "timezoneIdentifier", "timeZone", "timezone", "time_zone"] {
            guard let rawValue = object[key]?.stringValue else {
                continue
            }
            let trimmedValue = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedValue.isEmpty,
               TimeZone(identifier: trimmedValue) != nil {
                return trimmedValue
            }
        }
        return nil
    }

    func trustedHistoryDate(_ date: Date?) -> Date? {
        guard let date,
              CodexTimestampParser.isTrustworthyServerDate(date) else {
            return nil
        }
        return date
    }

    func parseHistoryDateString(_ value: String) -> Date? {
        CodexTimestampParser.parseString(value)
    }
}

private extension CodexService {
    func existingHistoryFallbackDate(for threadId: String) -> Date? {
        messagesByThread[threadId]?
            .map(\.createdAt)
            .filter { CodexTimestampParser.isTrustworthyServerDate($0) }
            .min()
    }
}
