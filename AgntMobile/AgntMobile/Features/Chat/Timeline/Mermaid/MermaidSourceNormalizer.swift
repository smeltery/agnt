// FILE: MermaidSourceNormalizer.swift
// Purpose: Mermaid source normalization for common model-generated syntax near-misses.
// Layer: View Support

import Foundation

enum MermaidSourceNormalizer {
    private static let looseArrowLabelRegex = try? NSRegularExpression(
        pattern: #"^(\s*.+?)\s*--\s+(.+?)\s+-->\s+(.+?)\s*$"#,
        options: []
    )
    private static let squareNodeRegex = try? NSRegularExpression(
        pattern: #"([A-Za-z][A-Za-z0-9_]*)\[([^\[\]\n"]+)\]"#,
        options: []
    )
    private static let decisionNodeRegex = try? NSRegularExpression(
        pattern: #"([A-Za-z][A-Za-z0-9_]*)\{([^{}\n"]+)\}"#,
        options: []
    )

    // Fixes common model-generated Mermaid near-misses without changing already-valid diagrams.
    static func normalized(_ source: String) -> String {
        source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line in
                let normalizedArrows = normalizeLooseArrowLabels(in: String(line))
                return normalizeNodeLabels(in: normalizedArrows)
            }
            .joined(separator: "\n")
    }

    private static func normalizeLooseArrowLabels(in line: String) -> String {
        guard !line.contains("-->|"),
              line.contains("--"),
              line.contains("-->"),
              let looseArrowLabelRegex else {
            return line
        }

        let range = NSRange(location: 0, length: (line as NSString).length)
        guard let match = looseArrowLabelRegex.firstMatch(in: line, range: range),
              match.numberOfRanges == 4,
              let fromRange = Range(match.range(at: 1), in: line),
              let labelRange = Range(match.range(at: 2), in: line),
              let toRange = Range(match.range(at: 3), in: line) else {
            return line
        }

        let from = String(line[fromRange]).trimmingCharacters(in: .whitespaces)
        let label = String(line[labelRange]).trimmingCharacters(in: .whitespaces)
        let to = String(line[toRange]).trimmingCharacters(in: .whitespaces)

        guard !from.isEmpty,
              !label.isEmpty,
              !to.isEmpty else {
            return line
        }

        return "\(from) -->|\(label)| \(to)"
    }

    private static func normalizeNodeLabels(in line: String) -> String {
        let squared = replaceNodeLabels(in: line, regex: squareNodeRegex, opening: "[", closing: "]")
        return replaceNodeLabels(in: squared, regex: decisionNodeRegex, opening: "{", closing: "}")
    }

    private static func replaceNodeLabels(
        in line: String,
        regex: NSRegularExpression?,
        opening: String,
        closing: String
    ) -> String {
        guard let regex else {
            return line
        }

        let nsLine = line as NSString
        let fullRange = NSRange(location: 0, length: nsLine.length)
        let matches = regex.matches(in: line, range: fullRange)
        guard !matches.isEmpty else {
            return line
        }

        let mutable = NSMutableString(string: line)
        for match in matches.reversed() {
            guard match.numberOfRanges == 3 else {
                continue
            }

            let idRange = match.range(at: 1)
            let labelRange = match.range(at: 2)
            guard idRange.location != NSNotFound,
                  labelRange.location != NSNotFound else {
                continue
            }

            let nodeID = nsLine.substring(with: idRange)
            let rawLabel = nsLine.substring(with: labelRange).trimmingCharacters(in: .whitespaces)
            guard !rawLabel.isEmpty,
                  !rawLabel.hasPrefix("\""),
                  !rawLabel.hasSuffix("\"") else {
                continue
            }

            let escapedLabel = rawLabel.replacingOccurrences(of: "\"", with: "&quot;")
            let replacement = "\(nodeID)\(opening)\"\(escapedLabel)\"\(closing)"
            mutable.replaceCharacters(in: match.range, with: replacement)
        }

        return String(mutable)
    }
}

