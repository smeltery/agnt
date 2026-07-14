// FILE: CodexService+HistoryGeneratedImages.swift
// Purpose: Merges generated-image history artifacts into final assistant answers.
// Layer: Service
// Exports: CodexService generated-image history helpers
// Depends on: CodexMessage, AssistantMarkdownImageReferenceParser

import Foundation

extension CodexService {
    // Canonical history may store generated-image artifacts as separate items; the
    // timeline presents them inside the final assistant answer for that turn.
    nonisolated static func historyMessagesMergingGeneratedImageArtifacts(_ messages: [CodexMessage]) -> [CodexMessage] {
        var result = messages
        let turnIds = Array(Set(result.compactMap(\.turnId)))
        for turnId in turnIds {
            let assistantIndices = result.indices.filter { index in
                result[index].role == .assistant && result[index].turnId == turnId
            }
            let imageOnlyIndices = assistantIndices.filter { index in
                Self.isHistoryGeneratedImageArtifactOnly(result[index].text)
            }
            guard !imageOnlyIndices.isEmpty,
                  let targetIndex = assistantIndices.last(where: { index in
                      !imageOnlyIndices.contains(index)
                          && result[index].assistantPhase == "final_answer"
                  }) else {
                continue
            }

            let existingText = result[targetIndex].text
            let existingImagePaths = Set(AssistantMarkdownImageReferenceParser.references(in: existingText).map(\.path))
            let imageText = imageOnlyIndices
                .filter { index in
                    AssistantMarkdownImageReferenceParser.references(in: result[index].text).contains { reference in
                        !existingImagePaths.contains(reference.path)
                    }
                }
                .map { result[$0].text.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: "\n\n")
            guard !imageText.isEmpty else {
                continue
            }
            result[targetIndex].text = [existingText, imageText]
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: "\n\n")
        }

        let removedIds = Set(result.indices.filter { index in
            if let turnId = result[index].turnId,
               Self.isHistoryGeneratedImageArtifactOnly(result[index].text) {
                return result.contains { candidate in
                    candidate.id != result[index].id
                        && candidate.role == .assistant
                        && candidate.turnId == turnId
                        && !Self.isHistoryGeneratedImageArtifactOnly(candidate.text)
                        && AssistantMarkdownImageReferenceParser.references(in: candidate.text).contains { reference in
                            result[index].text.contains(reference.path)
                        }
                }
            }
            return false
        }.map { result[$0].id })
        return result.filter { !removedIds.contains($0.id) }
    }

    nonisolated static func isHistoryGeneratedImageArtifactOnly(_ text: String) -> Bool {
        let imageReferences = AssistantMarkdownImageReferenceParser.references(in: text)
        guard !imageReferences.isEmpty,
              imageReferences.allSatisfy(\.isCodexGeneratedImage) else {
            return false
        }
        return AssistantMarkdownImageReferenceParser
            .visibleTextRemovingImageSyntax(from: text)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty
    }
}
