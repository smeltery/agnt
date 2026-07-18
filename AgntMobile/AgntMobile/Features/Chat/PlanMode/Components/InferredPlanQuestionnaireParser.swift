// FILE: InferredPlanQuestionnaireParser.swift
// Purpose: Plain-text plan questionnaire detection and parser.
// Layer: View Component

import SwiftUI

struct InferredPlanQuestionnaire: Hashable {
    let introText: String?
    let questions: [CodexStructuredUserInputQuestion]
    let outroText: String?
}

enum InferredPlanQuestionnaireParser {
    nonisolated static func parseAssistantMessage(_ text: String) -> InferredPlanQuestionnaire? {
        if hasAssistantQuestionnaireCue(in: text) {
            return parse(text)
        }

        if let choiceListQuestionnaire = parseAssistantChoiceList(text) {
            return choiceListQuestionnaire
        }

        // Some plan-mode fallbacks skip the "question for you" preamble and go straight
        // into a numbered decision list. Recover those into the native UI too.
        guard hasStructuredAssistantQuestionnaireShape(in: text) else {
            return nil
        }

        return parse(text)
    }

    nonisolated static func parse(_ text: String) -> InferredPlanQuestionnaire? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        let lines = trimmed.components(separatedBy: .newlines)
        var introLines: [String] = []
        var blocks: [QuestionBlock] = []
        var currentBlock: QuestionBlock?

        for rawLine in lines {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if let number = questionNumber(from: line) {
                if let currentBlock {
                    blocks.append(currentBlock)
                }
                currentBlock = QuestionBlock(number: number, lines: [questionBody(from: line)])
                continue
            }

            if currentBlock != nil {
                currentBlock?.lines.append(line)
            } else {
                introLines.append(line)
            }
        }

        if let currentBlock {
            blocks.append(currentBlock)
        }

        let parsedQuestions = blocks.map(parseQuestionBlock)
        let usableParsedQuestions = dropTrailingIncompleteQuestions(from: parsedQuestions)
        let questions = usableParsedQuestions.compactMap(\.question)
        guard !questions.isEmpty, questions.count == usableParsedQuestions.count else {
            return nil
        }

        let hasEnoughStructure = questions.count >= 2 || questions.contains(where: { !$0.options.isEmpty })
        guard hasEnoughStructure else {
            return nil
        }

        guard usableParsedQuestions.allSatisfy(\.isQuestionLike) else {
            return nil
        }

        let introText = normalizeTextBlock(introLines)
        let outroText = normalizeTextBlock(usableParsedQuestions.flatMap(\.outroLines))

        return InferredPlanQuestionnaire(
            introText: introText,
            questions: questions,
            outroText: outroText
        )
    }

    nonisolated private static func parseQuestionBlock(_ block: QuestionBlock) -> ParsedQuestionBlock {
        var promptLines: [String] = []
        var optionLines: [String] = []
        var outroLines: [String] = []
        var reachedOutro = false

        for rawLine in block.lines {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty else {
                if !reachedOutro, !optionLines.isEmpty {
                    continue
                }
                if reachedOutro {
                    outroLines.append(line)
                } else {
                    promptLines.append(line)
                }
                continue
            }

            if shouldTreatAsOutroLine(line) {
                reachedOutro = true
            }

            if reachedOutro {
                outroLines.append(line)
                continue
            }

            if let option = bulletText(from: line) {
                optionLines.append(option)
            } else if !optionLines.isEmpty {
                let lastIndex = optionLines.index(before: optionLines.endIndex)
                optionLines[lastIndex] = "\(optionLines[lastIndex]) \(line)".trimmingCharacters(in: .whitespacesAndNewlines)
            } else {
                promptLines.append(line)
            }
        }

        let rawPrompt = normalizeTextBlock(promptLines) ?? ""
        guard !rawPrompt.isEmpty else {
            return ParsedQuestionBlock(question: nil, outroLines: outroLines)
        }

        let explicitOptions = optionLines.map { optionLine in
            CodexStructuredUserInputOption(label: optionLine, description: "")
        }
        let inlineOptions = explicitOptions.isEmpty ? inferredInlineOptions(from: rawPrompt) : nil
        let prompt = inlineOptions?.question ?? rawPrompt
        let options = inlineOptions?.options ?? explicitOptions

        let selectionLimit = inferredSelectionLimit(from: prompt)
        let question = CodexStructuredUserInputQuestion(
            id: "inferred_plan_q_\(block.number)",
            header: "",
            question: prompt,
            isOther: false,
            isSecret: false,
            selectionLimit: selectionLimit,
            options: options
        )

        return ParsedQuestionBlock(question: question, outroLines: outroLines)
    }

    nonisolated private static func questionNumber(from line: String) -> Int? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = trimmed.replacingOccurrences(
            of: #"^\**\s*|\s*\**$"#,
            with: "",
            options: .regularExpression
        )

        guard let match = normalized.range(
            of: #"^\d+[\.\)]\s+"#,
            options: .regularExpression
        ) else {
            return nil
        }

        let prefix = String(normalized[..<match.upperBound])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let digits = prefix.replacingOccurrences(
            of: #"[^\d]"#,
            with: "",
            options: .regularExpression
        )

        return Int(digits)
    }

    nonisolated private static func questionBody(from line: String) -> String {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = trimmed.replacingOccurrences(
            of: #"^\**\s*|\s*\**$"#,
            with: "",
            options: .regularExpression
        )

        guard let match = normalized.range(
            of: #"^\d+[\.\)]\s+"#,
            options: .regularExpression
        ) else {
            return normalized
        }

        return String(normalized[match.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    nonisolated private static func bulletText(from line: String) -> String? {
        let prefixes = ["• ", "- ", "* ", "+ ", "•", "-", "*", "+"]
        for prefix in prefixes {
            if line.hasPrefix(prefix) {
                return String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return nil
    }

    nonisolated private static func inferredSelectionLimit(from prompt: String) -> Int? {
        let lowered = prompt.lowercased()
        if lowered.contains("up to two") || lowered.contains("choose two") || lowered.contains("pick two") {
            return 2
        }
        if lowered.contains("up to three") || lowered.contains("choose three") || lowered.contains("pick three") {
            return 3
        }
        return nil
    }

    nonisolated private static func shouldTreatAsOutroLine(_ line: String) -> Bool {
        let lowered = line.lowercased()
        return lowered.hasPrefix("once you answer")
            || lowered.hasPrefix("if you answer")
            || lowered.hasPrefix("when you answer")
            || lowered.hasPrefix("after you answer")
            || lowered.hasPrefix("i’ll turn this into")
            || lowered.hasPrefix("i'll turn this into")
            || lowered.hasPrefix("then i’ll")
            || lowered.hasPrefix("then i'll")
    }

    nonisolated private static func hasAssistantQuestionnaireCue(in text: String) -> Bool {
        let lowered = text.lowercased()
        return lowered.contains("questions for you")
            || lowered.contains("question for you")
            || lowered.contains("quick questions")
            || lowered.contains("a few questions")
            || lowered.contains("need your input")
            || lowered.contains("need your answer")
            || lowered.contains("need your answers")
            || lowered.contains("answer these")
            || lowered.contains("once you answer")
            || lowered.contains("if you answer")
            || lowered.contains("when you answer")
            || lowered.contains("after you answer")
    }

    nonisolated private static func parseAssistantChoiceList(_ text: String) -> InferredPlanQuestionnaire? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        let lines = trimmed.components(separatedBy: .newlines)
        guard let cueIndex = lines.firstIndex(where: { isAssistantChoiceCue($0) }) else {
            return nil
        }

        let introText = normalizeTextBlock(Array(lines[..<cueIndex]))
        let optionLines = Array(lines[(cueIndex + 1)...])
        let optionBlocks = numberedOptionBlocks(from: optionLines)
        guard optionBlocks.count >= 2 else {
            return nil
        }

        let options = optionBlocks.compactMap(makeChoiceListOption)
        guard options.count >= 2 else {
            return nil
        }

        return InferredPlanQuestionnaire(
            introText: introText,
            questions: [
                CodexStructuredUserInputQuestion(
                    id: "inferred_plan_next_step",
                    header: "Next step",
                    question: "What should Codex produce next?",
                    isOther: false,
                    isSecret: false,
                    options: options
                ),
            ],
            outroText: nil
        )
    }

    nonisolated private static func hasStructuredAssistantQuestionnaireShape(in text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return false
        }

        let lines = trimmed.components(separatedBy: .newlines)
        let numberedQuestionLines = lines.filter { questionNumber(from: $0) != nil }
        let bulletLines = lines.filter { bulletText(from: $0.trimmingCharacters(in: .whitespacesAndNewlines)) != nil }
        let questionMarkCount = lines.reduce(into: 0) { partialResult, line in
            partialResult += line.filter { $0 == "?" }.count
        }

        if numberedQuestionLines.count >= 2 && questionMarkCount >= 1 {
            return true
        }

        if numberedQuestionLines.count >= 1 && !bulletLines.isEmpty {
            return true
        }

        return false
    }

    nonisolated private static func isAssistantChoiceCue(_ line: String) -> Bool {
        let lowered = line.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return lowered.contains("one of these")
            || lowered.contains("turn this into")
            || lowered.contains("choose one")
            || lowered.contains("pick one")
    }

    nonisolated private static func numberedOptionBlocks(from lines: [String]) -> [QuestionBlock] {
        var blocks: [QuestionBlock] = []
        var currentBlock: QuestionBlock?

        for rawLine in lines {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if let number = questionNumber(from: line) {
                if let currentBlock {
                    blocks.append(currentBlock)
                }
                currentBlock = QuestionBlock(number: number, lines: [questionBody(from: line)])
                continue
            }

            guard currentBlock != nil else {
                continue
            }

            currentBlock?.lines.append(line)
        }

        if let currentBlock {
            blocks.append(currentBlock)
        }

        return blocks
    }

    nonisolated private static func makeChoiceListOption(from block: QuestionBlock) -> CodexStructuredUserInputOption? {
        let normalizedLines = block.lines
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard let firstLine = normalizedLines.first else {
            return nil
        }

        let description = normalizedLines.dropFirst().joined(separator: "\n")
        return CodexStructuredUserInputOption(
            label: firstLine,
            description: description
        )
    }

    nonisolated private static func inferredInlineOptions(
        from prompt: String
    ) -> (question: String, options: [CodexStructuredUserInputOption])? {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasSuffix("?"),
              let colonIndex = trimmed.firstIndex(of: ":") else {
            return nil
        }

        let question = String(trimmed[..<colonIndex]).trimmingCharacters(in: .whitespacesAndNewlines) + "?"
        var optionsText = String(trimmed[trimmed.index(after: colonIndex)...])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !optionsText.isEmpty else {
            return nil
        }
        if optionsText.hasSuffix("?") {
            optionsText.removeLast()
        }

        let normalizedOptionsText = optionsText
            .replacingOccurrences(of: ", or ", with: ", ", options: [.caseInsensitive])
            .replacingOccurrences(of: " or ", with: ", ", options: [.caseInsensitive])
            .replacingOccurrences(of: ", and ", with: ", ", options: [.caseInsensitive])
            .replacingOccurrences(of: " and ", with: ", ", options: [.caseInsensitive])

        let optionLabels = normalizedOptionsText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        guard optionLabels.count >= 2, optionLabels.count <= 6 else {
            return nil
        }

        let options = optionLabels.map { label in
            CodexStructuredUserInputOption(label: label, description: "")
        }
        return (question, options)
    }

    nonisolated private static func dropTrailingIncompleteQuestions(
        from parsedQuestions: [ParsedQuestionBlock]
    ) -> [ParsedQuestionBlock] {
        var usableQuestions = parsedQuestions
        while let last = usableQuestions.last, !last.isQuestionLike {
            usableQuestions.removeLast()
        }
        return usableQuestions
    }

    nonisolated private static func normalizeTextBlock(_ lines: [String]) -> String? {
        let normalized = lines
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .reduce(into: [String]()) { result, line in
                if line.isEmpty {
                    if result.last != "" {
                        result.append("")
                    }
                } else {
                    result.append(line)
                }
            }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? nil : normalized
    }
}

private struct QuestionBlock {
    let number: Int
    var lines: [String]
}

private struct ParsedQuestionBlock {
    let question: CodexStructuredUserInputQuestion?
    let outroLines: [String]

    nonisolated var isQuestionLike: Bool {
        guard let question else {
            return false
        }

        return question.question.contains("?") || !question.options.isEmpty
    }
}
