// FILE: StreamingInlineMarkupAutoCloser.swift
// Purpose: Stabilizes inline markdown while assistant text is still streaming.
// Layer: Turn UI rendering support
// Exports: StreamingInlineMarkupAutoCloser
// Depends on: Foundation

import Foundation

enum StreamingInlineMarkupAutoCloser {
    static func autoClosed(_ text: String) -> String {
        guard !text.isEmpty else { return text }

        var scanner = ScannerState()
        var fence = StreamingMarkdownFence()
        var lineStart = text.startIndex
        while lineStart < text.endIndex {
            let lineEnd = text[lineStart...].firstIndex(of: "\n") ?? text.endIndex
            let line = text[lineStart..<lineEnd]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if fence.consume(String(line)) || trimmed.isEmpty {
                // Inline spans cannot cross paragraph or fenced-code boundaries.
                scanner.codeOpen = false
                scanner.boldOpen = false
                scanner.codeHasContent = false
                scanner.boldHasContent = false
            } else {
                scanner.scan(line, isFinalLine: lineEnd == text.endIndex)
            }

            lineStart = lineEnd < text.endIndex ? text.index(after: lineEnd) : text.endIndex
        }

        guard !fence.isOpen else { return text }

        if scanner.codeOpen, !scanner.codeHasContent {
            var held = String(text[..<scanner.codeStart])
            if scanner.boldOpen, scanner.boldHasContent {
                held = trimmingTrailingWhitespace(held) + "**"
            }
            return held
        }

        if scanner.boldOpen, !scanner.boldHasContent {
            return String(text[..<scanner.boldStart])
        }

        var closed = text
        if scanner.codeOpen {
            closed += "`"
        }
        if scanner.boldOpen {
            if !scanner.codeOpen {
                closed = trimmingTrailingWhitespace(closed)
            }
            closed += "**"
        }
        return closed
    }

    private struct ScannerState {
        var codeOpen = false
        var codeStart: String.Index!
        var codeHasContent = false
        var boldOpen = false
        var boldStart: String.Index!
        var boldHasContent = false

        mutating func scan(_ line: Substring, isFinalLine: Bool) {
            var index = line.startIndex
            while index < line.endIndex {
                let character = line[index]

                if character == "\\" {
                    index = line.index(after: index)
                    if index < line.endIndex {
                        index = line.index(after: index)
                    }
                    markContent()
                    continue
                }

                if character == "`" {
                    if codeOpen {
                        codeOpen = false
                        if boldOpen {
                            boldHasContent = true
                        }
                    } else {
                        codeOpen = true
                        codeStart = index
                        codeHasContent = false
                    }
                    index = line.index(after: index)
                    continue
                }

                if character == "*", !codeOpen {
                    let next = line.index(after: index)
                    if next < line.endIndex, line[next] == "*" {
                        let afterPair = line.index(after: next)
                        if boldOpen {
                            boldOpen = false
                            boldHasContent = false
                        } else if afterPair < line.endIndex, !line[afterPair].isWhitespace {
                            boldOpen = true
                            boldStart = index
                            boldHasContent = false
                        } else if afterPair == line.endIndex, isFinalLine {
                            boldOpen = true
                            boldStart = index
                            boldHasContent = false
                        }
                        index = afterPair
                        continue
                    }
                }

                if !character.isWhitespace {
                    markContent()
                }
                index = line.index(after: index)
            }
        }

        private mutating func markContent() {
            if codeOpen {
                codeHasContent = true
            }
            if boldOpen {
                boldHasContent = true
            }
        }
    }

    private static func trimmingTrailingWhitespace(_ text: String) -> String {
        var end = text.endIndex
        while end > text.startIndex {
            let previous = text.index(before: end)
            guard text[previous].isWhitespace else { break }
            end = previous
        }
        return end == text.endIndex ? text : String(text[..<end])
    }
}
