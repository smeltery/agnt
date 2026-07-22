// FILE: GhosttyTerminalView+Selection.swift
// Purpose: Terminal selection geometry and text extraction for GhosttyTerminalView.
// Layer: View Infrastructure

import Foundation
import GhosttyKit
import UIKit

extension GhosttyTerminalView {
    func updateSelectionOverlay() {
        selectionOverlay.metrics = currentSelectionMetrics()
        if let selectionRange {
            selectionOverlay.selectionRange = selectionRange
            selectionMenuTargetRect = selectionOverlay.menuTargetRect()
        } else {
            selectionOverlay.selectionRange = nil
            selectionMenuTargetRect = nil
        }
    }

    func clearAppSelection() {
        selectionEditMenuInteraction?.dismissMenu()
        isSelectingText = false
        selectionAnchorCell = nil
        selectionFocusCell = nil
        handleDragOppositeCell = nil
        handleDragStartCell = nil
        handleDragStartLocation = nil
        handleDragTouchOffset = nil
        selectionGestureStartPoint = nil
        selectionGestureDidDrag = false
        selectedTextForEditMenu = ""
        selectionMenuTargetRect = nil
        selectionOverlay.selectionRange = nil
    }

    var selectionRange: TerminalSelectionRange? {
        guard let selectionAnchorCell, let selectionFocusCell else { return nil }
        return TerminalSelectionRange(anchor: selectionAnchorCell, focus: selectionFocusCell)
    }

    func terminalCell(at location: CGPoint) -> TerminalSelectionCell? {
        guard let metrics = currentSelectionMetrics() else { return nil }
        let clampedX = min(max(location.x, 0), max(terminalViewport.bounds.width - 1, 0))
        let clampedY = min(max(location.y, 0), max(terminalViewport.bounds.height - 1, 0))
        let column = min(max(Int(floor(clampedX / metrics.cellSize.width)), 0), metrics.columns - 1)
        let row = min(max(Int(floor(clampedY / metrics.cellSize.height)), 0), metrics.rows - 1)
        return TerminalSelectionCell(column: column, row: row)
    }

    func terminalCellForHandleDrag(at location: CGPoint) -> TerminalSelectionCell? {
        guard let metrics = currentSelectionMetrics(),
              let handleDragStartCell,
              let handleDragStartLocation,
              let handleDragTouchOffset else { return nil }

        let effectiveHandleLocation = CGPoint(
            x: location.x - handleDragTouchOffset.x,
            y: location.y - handleDragTouchOffset.y
        )
        let columnDelta = Int(round((effectiveHandleLocation.x - handleDragStartLocation.x) / metrics.cellSize.width))
        let rowDelta = Int(round((effectiveHandleLocation.y - handleDragStartLocation.y) / metrics.cellSize.height))
        return TerminalSelectionCell(
            column: min(max(handleDragStartCell.column + columnDelta, 0), metrics.columns - 1),
            row: min(max(handleDragStartCell.row + rowDelta, 0), metrics.rows - 1)
        )
    }

    func handleBoundaryPoint(
        for cell: TerminalSelectionCell,
        handle: TerminalSelectionHandle,
        metrics: TerminalSelectionMetrics
    ) -> CGPoint {
        CGPoint(
            x: CGFloat(cell.column + (handle == .end ? 1 : 0)) * metrics.cellSize.width,
            y: CGFloat(cell.row + 1) * metrics.cellSize.height
        )
    }

    func currentSelectionMetrics() -> TerminalSelectionMetrics? {
        guard let surface else { return nil }
        let size = ghostty_surface_size(surface)
        guard size.columns > 0,
              size.rows > 0,
              size.cell_width_px > 0,
              size.cell_height_px > 0 else {
            return nil
        }

        return TerminalSelectionMetrics(
            columns: Int(size.columns),
            rows: Int(size.rows),
            cellSize: CGSize(
                width: CGFloat(size.cell_width_px) / contentScaleFactor,
                height: CGFloat(size.cell_height_px) / contentScaleFactor
            )
        )
    }

    func wordSelectionRange(at cell: TerminalSelectionCell) -> TerminalSelectionRange? {
        guard let metrics = currentSelectionMetrics() else { return nil }
        guard let rowText = visibleTerminalLine(at: cell.row, metrics: metrics) else { return nil }

        let rowCharacters = terminalRowCharacters(for: rowText, maxColumns: metrics.columns)
        guard let selectedIndex = rowCharacters.firstIndex(where: { rowCharacter in
            cell.column >= rowCharacter.startColumn && cell.column < rowCharacter.endColumn
        }) else {
            return nil
        }

        guard isTerminalWordCharacter(rowCharacters[selectedIndex].character) else { return nil }

        var startIndex = selectedIndex
        while startIndex > 0, isTerminalWordCharacter(rowCharacters[startIndex - 1].character) {
            startIndex -= 1
        }

        var endIndex = selectedIndex
        while endIndex + 1 < rowCharacters.count, isTerminalWordCharacter(rowCharacters[endIndex + 1].character) {
            endIndex += 1
        }

        let startColumn = rowCharacters[startIndex].startColumn
        let endColumn = max(rowCharacters[endIndex].endColumn - 1, startColumn)
        return TerminalSelectionRange(
            anchor: TerminalSelectionCell(column: min(startColumn, metrics.columns - 1), row: cell.row),
            focus: TerminalSelectionCell(column: min(endColumn, metrics.columns - 1), row: cell.row)
        )
    }

    func terminalRowCharacters(for line: String, maxColumns: Int) -> [TerminalRowCharacter] {
        var rowCharacters: [TerminalRowCharacter] = []
        var column = 0

        for character in line {
            let width = terminalDisplayWidth(of: character)
            guard width > 0 else { continue }

            let startColumn = column
            let endColumn = min(column + width, maxColumns)
            guard startColumn < maxColumns, endColumn > startColumn else { break }

            rowCharacters.append(
                TerminalRowCharacter(
                    character: character,
                    startColumn: startColumn,
                    endColumn: endColumn
                )
            )
            column += width
        }

        return rowCharacters
    }

    func isTerminalWordCharacter(_ character: Character) -> Bool {
        for scalar in character.unicodeScalars {
            if CharacterSet.whitespacesAndNewlines.contains(scalar)
                || CharacterSet.controlCharacters.contains(scalar) {
                return false
            }
        }
        return true
    }

    func terminalDisplayWidth(of character: Character) -> Int {
        var hasVisibleScalar = false
        var hasWideScalar = false

        for scalar in character.unicodeScalars {
            if isZeroWidthTerminalScalar(scalar) || CharacterSet.controlCharacters.contains(scalar) {
                continue
            }

            hasVisibleScalar = true
            if isWideTerminalScalar(scalar) {
                hasWideScalar = true
            }
        }

        guard hasVisibleScalar else { return 0 }
        return hasWideScalar ? 2 : 1
    }

    func isZeroWidthTerminalScalar(_ scalar: Unicode.Scalar) -> Bool {
        let value = scalar.value
        return CharacterSet.nonBaseCharacters.contains(scalar)
            || value == 0x200C
            || value == 0x200D
            || (0xFE00...0xFE0F).contains(value)
            || (0xE0100...0xE01EF).contains(value)
    }

    func isWideTerminalScalar(_ scalar: Unicode.Scalar) -> Bool {
        let value = scalar.value
        return (0x1100...0x115F).contains(value)
            || value == 0x2329
            || value == 0x232A
            || (0x2E80...0xA4CF).contains(value)
            || (0xAC00...0xD7A3).contains(value)
            || (0xF900...0xFAFF).contains(value)
            || (0xFE10...0xFE19).contains(value)
            || (0xFE30...0xFE6F).contains(value)
            || (0xFF00...0xFF60).contains(value)
            || (0xFFE0...0xFFE6).contains(value)
            || (0x1F1E6...0x1F1FF).contains(value)
            || (0x1F300...0x1FAFF).contains(value)
    }

    func readTextForCurrentSelection() -> String? {
        guard let selectionRange,
              let metrics = currentSelectionMetrics(),
              let rows = visibleTerminalRows(metrics: metrics) else { return nil }
        return selectedText(for: selectionRange, rows: rows, metrics: metrics)
    }

    func visibleTerminalLine(at row: Int, metrics: TerminalSelectionMetrics) -> String? {
        guard let rows = visibleTerminalRows(metrics: metrics), row >= 0, row < rows.count else { return nil }
        return rows[row].text
    }

    func selectedText(
        for selectionRange: TerminalSelectionRange,
        rows: [TerminalVisualRow],
        metrics: TerminalSelectionMetrics
    ) -> String {
        let normalizedRange = selectionRange.normalized
        let start = normalizedRange.start
        let end = normalizedRange.end
        guard start.row <= end.row else { return "" }

        let rowRange = Array(start.row...end.row)
        var output = ""
        for (index, row) in rowRange.enumerated() {
            let visualRow = row >= 0 && row < rows.count ? rows[row] : TerminalVisualRow(text: "", hasHardLineBreakAfter: false)
            let firstColumn = row == start.row ? start.column : 0
            let lastColumn = row == end.row ? end.column : metrics.columns - 1
            output += terminalLineText(
                visualRow.text,
                from: firstColumn,
                through: lastColumn,
                maxColumns: metrics.columns,
                includeTrailingBlankCells: row == end.row
            )
            if index < rowRange.count - 1, visualRow.hasHardLineBreakAfter {
                output += "\n"
            }
        }
        return output
    }

    func terminalLineText(
        _ line: String,
        from firstColumn: Int,
        through lastColumn: Int,
        maxColumns: Int,
        includeTrailingBlankCells: Bool
    ) -> String {
        guard lastColumn >= firstColumn else { return "" }
        let selectedStart = min(max(firstColumn, 0), maxColumns - 1)
        let selectedEnd = min(max(lastColumn, selectedStart), maxColumns - 1)
        let rowCharacters = terminalRowCharacters(for: line, maxColumns: maxColumns)
        var output = ""
        var cursorColumn = selectedStart

        for rowCharacter in rowCharacters where rowCharacter.endColumn > selectedStart && rowCharacter.startColumn <= selectedEnd {
            if rowCharacter.startColumn > cursorColumn {
                output += String(repeating: " ", count: rowCharacter.startColumn - cursorColumn)
            }
            output.append(rowCharacter.character)
            cursorColumn = max(cursorColumn, rowCharacter.endColumn)
        }

        if includeTrailingBlankCells, cursorColumn <= selectedEnd {
            output += String(repeating: " ", count: selectedEnd - cursorColumn + 1)
        }

        return output
    }

    func visibleTerminalRows(metrics: TerminalSelectionMetrics) -> [TerminalVisualRow]? {
        guard let visibleText = readVisibleTerminalText() else { return nil }
        let hardLines = visibleText
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { String($0).trimmingCharacters(in: CharacterSet(charactersIn: "\r")) }
        return visualTerminalRows(from: hardLines, metrics: metrics)
    }

    func visualTerminalRows(from hardLines: [String], metrics: TerminalSelectionMetrics) -> [TerminalVisualRow] {
        var rows: [TerminalVisualRow] = []

        for (hardLineIndex, hardLine) in hardLines.enumerated() {
            let wrappedRows = wrapTerminalLine(hardLine, maxColumns: metrics.columns)
            for (wrappedRowIndex, wrappedRow) in wrappedRows.enumerated() {
                rows.append(
                    TerminalVisualRow(
                        text: wrappedRow,
                        hasHardLineBreakAfter: hardLineIndex < hardLines.count - 1 && wrappedRowIndex == wrappedRows.count - 1
                    )
                )
            }
            if rows.count >= metrics.rows {
                return Array(rows.prefix(metrics.rows))
            }
        }

        if rows.count < metrics.rows {
            rows.append(
                contentsOf: Array(
                    repeating: TerminalVisualRow(text: "", hasHardLineBreakAfter: false),
                    count: metrics.rows - rows.count
                )
            )
        }
        return rows
    }

    func wrapTerminalLine(_ line: String, maxColumns: Int) -> [String] {
        guard maxColumns > 0 else { return [line] }
        var rows: [String] = []
        var currentRow = ""
        var currentWidth = 0

        for character in line {
            let width = max(terminalDisplayWidth(of: character), 0)
            if width > 0, currentWidth + width > maxColumns {
                rows.append(currentRow)
                currentRow = ""
                currentWidth = 0
            }
            currentRow.append(character)
            currentWidth += width
        }

        rows.append(currentRow)
        return rows
    }

    func readVisibleTerminalText() -> String? {
        guard let metrics = currentSelectionMetrics() else { return nil }
        return readText(
            for: TerminalSelectionRange(
                anchor: TerminalSelectionCell(column: 0, row: 0),
                focus: TerminalSelectionCell(column: metrics.columns - 1, row: metrics.rows - 1)
            )
        )
    }

    func visibleTextForSelection() -> String? {
        guard let rawText = readVisibleTerminalText() else { return nil }
        return TerminalSelectableTextNormalizer.normalizedText(from: rawText)
    }

    func readText(for selectionRange: TerminalSelectionRange) -> String? {
        guard let surface else { return nil }
        let normalizedRange = selectionRange.normalized
        var selection = ghostty_selection_s()
        selection.top_left = ghostty_point_s(
            tag: GHOSTTY_POINT_VIEWPORT,
            coord: GHOSTTY_POINT_COORD_TOP_LEFT,
            x: UInt32(normalizedRange.start.column),
            y: UInt32(normalizedRange.start.row)
        )
        selection.bottom_right = ghostty_point_s(
            tag: GHOSTTY_POINT_VIEWPORT,
            coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT,
            x: UInt32(normalizedRange.end.column),
            y: UInt32(normalizedRange.end.row)
        )
        selection.rectangle = false

        var text = ghostty_text_s(
            tl_px_x: 0,
            tl_px_y: 0,
            offset_start: 0,
            offset_len: 0,
            text: nil,
            text_len: 0
        )

        guard ghostty_surface_read_text(surface, selection, &text) else { return nil }
        defer { ghostty_surface_free_text(surface, &text) }
        guard let pointer = text.text, text.text_len > 0 else { return nil }

        let bytes = UnsafeBufferPointer(
            start: UnsafeRawPointer(pointer).assumingMemoryBound(to: UInt8.self),
            count: Int(text.text_len)
        )
        return String(decoding: bytes, as: UTF8.self)
    }

    // Clipboard callbacks let Ghostty's own copy/paste actions bridge to the iOS pasteboard.
    func completeClipboardRead(state: UnsafeMutableRawPointer?) -> Bool {
        guard let surface else { return false }

        let text = readSystemPasteboardString()
        text.withCString { cString in
            ghostty_surface_complete_clipboard_request(surface, cString, state, !text.isEmpty)
        }
        return true
    }

    // Chooses plain text when Ghostty provides multiple clipboard representations.
    func writeClipboard(contents: UnsafePointer<ghostty_clipboard_content_s>?, count: Int) {
        guard let contents, count > 0 else { return }

        var fallbackText: String?
        for index in 0..<count {
            let item = contents[index]
            guard let data = item.data else { continue }
            let text = String(cString: data)
            let mime = item.mime.map { String(cString: $0) } ?? ""

            if mime == "text/plain" || mime.hasPrefix("text/") {
                writeSystemPasteboardString(text)
                return
            }
            fallbackText = fallbackText ?? text
        }

        if let fallbackText {
            writeSystemPasteboardString(fallbackText)
        }
    }

    func readSystemPasteboardString() -> String {
        if Thread.isMainThread {
            return UIPasteboard.general.string ?? ""
        }

        var value = ""
        DispatchQueue.main.sync {
            value = UIPasteboard.general.string ?? ""
        }
        return value
    }

    func writeSystemPasteboardString(_ text: String) {
        if Thread.isMainThread {
            UIPasteboard.general.string = text
        } else {
            DispatchQueue.main.async {
                UIPasteboard.general.string = text
            }
        }
    }

    // MARK: - Ghostty Surface
}
