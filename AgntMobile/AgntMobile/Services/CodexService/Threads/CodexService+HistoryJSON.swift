// FILE: CodexService+HistoryJSON.swift
// Purpose: Shared JSON extraction helpers for thread/read history decoding.
// Layer: Service
// Exports: CodexService history JSON helpers
// Depends on: Foundation, JSONValue

import Foundation

extension CodexService {
    func decodeHistoryFirstString(
        forAnyKey keys: [String],
        in root: JSONValue,
        maxDepth: Int = 8
    ) -> String? {
        for key in keys {
            if let value = decodeHistoryFirstValue(forKey: key, in: root, maxDepth: maxDepth) {
                if let text = value.stringValue {
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty {
                        return trimmed
                    }
                }

                if let flattened = decodeHistoryFlattenText(from: value, maxDepth: maxDepth),
                   !flattened.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    return flattened.trimmingCharacters(in: .whitespacesAndNewlines)
                }
            }
        }
        return nil
    }

    func decodeHistoryFirstValue(
        forAnyKey keys: [String],
        in root: JSONValue,
        maxDepth: Int = 8
    ) -> JSONValue? {
        for key in keys {
            if let value = decodeHistoryFirstValue(forKey: key, in: root, maxDepth: maxDepth) {
                return value
            }
        }
        return nil
    }

    func decodeHistoryFirstValue(
        forKey key: String,
        in root: JSONValue,
        maxDepth: Int = 8
    ) -> JSONValue? {
        guard maxDepth >= 0 else { return nil }

        switch root {
        case .object(let object):
            if let value = object[key], !decodeHistoryIsEmptyJSONValue(value) {
                return value
            }
            for value in object.values {
                if let match = decodeHistoryFirstValue(forKey: key, in: value, maxDepth: maxDepth - 1) {
                    return match
                }
            }
        case .array(let array):
            for value in array {
                if let match = decodeHistoryFirstValue(forKey: key, in: value, maxDepth: maxDepth - 1) {
                    return match
                }
            }
        default:
            break
        }
        return nil
    }

    func decodeHistoryFlattenText(from root: JSONValue, maxDepth: Int = 8) -> String? {
        guard maxDepth >= 0 else { return nil }
        switch root {
        case .string(let text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        case .array(let values):
            let parts = values.compactMap { decodeHistoryFlattenText(from: $0, maxDepth: maxDepth - 1) }
            guard !parts.isEmpty else { return nil }
            return parts.joined(separator: "\n")
        case .object(let object):
            let preferredKeys = ["text", "message", "summary", "output_text", "outputText", "content", "output"]
            for key in preferredKeys {
                if let value = object[key],
                   let preferred = decodeHistoryFlattenText(from: value, maxDepth: maxDepth - 1) {
                    return preferred
                }
            }
            for value in object.values {
                if let nested = decodeHistoryFlattenText(from: value, maxDepth: maxDepth - 1) {
                    return nested
                }
            }
            return nil
        default:
            return nil
        }
    }

    func decodeHistoryIsEmptyJSONValue(_ value: JSONValue) -> Bool {
        switch value {
        case .null:
            return true
        case .string(let text):
            return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .array(let values):
            return values.isEmpty
        case .object(let object):
            return object.isEmpty
        default:
            return false
        }
    }

    func decodeHistoryStringParts(_ value: JSONValue?) -> [String] {
        guard let value else { return [] }

        switch value {
        case .string(let text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? [] : [trimmed]
        case .array(let values):
            return values.compactMap { candidate in
                if let text = candidate.stringValue {
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    return trimmed.isEmpty ? nil : trimmed
                }

                if let object = candidate.objectValue,
                   let text = object["text"]?.stringValue {
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    return trimmed.isEmpty ? nil : trimmed
                }

                return nil
            }
        case .object(let object):
            if let text = object["text"]?.stringValue {
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? [] : [trimmed]
            }
            return []
        default:
            return []
        }
    }
}
