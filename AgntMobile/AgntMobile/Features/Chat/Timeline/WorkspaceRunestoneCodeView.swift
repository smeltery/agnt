// FILE: WorkspaceRunestoneCodeView.swift
// Purpose: Renders workspace text files with syntax highlighting, line numbers, and
//          selection via Runestone + TreeSitter grammars.
// Layer: Timeline preview (UIKit code viewer)
// Exports: WorkspaceRunestoneCodeFileView
// Depends on: SwiftUI, UIKit, Runestone, TreeSitter* grammar packages, AppFont

import SwiftUI
import UIKit
import Runestone
import TreeSitterBashRunestone
import TreeSitterCPPRunestone
import TreeSitterCRunestone
import TreeSitterCSSRunestone
import TreeSitterCSharpRunestone
import TreeSitterGoRunestone
import TreeSitterHTMLRunestone
import TreeSitterJavaRunestone
import TreeSitterJavaScriptRunestone
import TreeSitterJSONRunestone
import TreeSitterMarkdownRunestone
import TreeSitterPythonRunestone
import TreeSitterRubyRunestone
import TreeSitterRustRunestone
import TreeSitterSQLRunestone
import TreeSitterSwiftRunestone
import TreeSitterTOMLRunestone
import TreeSitterTSXRunestone
import TreeSitterTypeScriptRunestone
import TreeSitterYAMLRunestone

struct WorkspaceRunestoneCodeFileView: UIViewRepresentable {
    let content: String
    let fileName: String
    let colorScheme: ColorScheme

    private static let highlightedTextMaxUTF8Bytes = 512 * 1024

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context _: Context) -> TextView {
        let textView = TextView(frame: .zero)
        configure(textView)
        return textView
    }

    func updateUIView(_ uiView: TextView, context: Context) {
        configure(uiView)

        let renderedContent = displayContent
        // Large files remain scrollable/selectable while avoiding Tree-sitter work on the main thread.
        let shouldSyntaxHighlight = renderedContent.utf8.count <= Self.highlightedTextMaxUTF8Bytes
        let languageID = shouldSyntaxHighlight
            ? WorkspaceRunestoneLanguageResolver.languageID(for: fileName)
            : "plain"
        let signature = Coordinator.Signature(
            content: renderedContent,
            languageID: languageID,
            isDark: colorScheme == .dark
        )

        guard context.coordinator.signature != signature else {
            return
        }

        context.coordinator.signature = signature
        let theme = WorkspaceRunestoneTheme(colorScheme: colorScheme)
        let language = shouldSyntaxHighlight ? WorkspaceRunestoneLanguageResolver.language(for: fileName) : nil
        if let language {
            uiView.setState(TextViewState(text: renderedContent, theme: theme, language: language))
        } else {
            uiView.setState(TextViewState(text: renderedContent, theme: theme))
        }
    }

    private func configure(_ textView: TextView) {
        textView.isEditable = false
        textView.isSelectable = true
        textView.showLineNumbers = true
        textView.lineSelectionDisplayType = .line
        textView.isLineWrappingEnabled = false
        textView.lineHeightMultiplier = 1.22
        textView.textContainerInset = UIEdgeInsets(top: 14, left: 10, bottom: 14, right: 18)
        textView.backgroundColor = WorkspaceRunestoneTheme.backgroundUIColor(for: colorScheme)
        textView.selectionBarColor = .systemBlue
        textView.selectionHighlightColor = UIColor.systemBlue.withAlphaComponent(0.18)
        textView.autocorrectionType = .no
        textView.autocapitalizationType = .none
        textView.smartDashesType = .no
        textView.smartQuotesType = .no
        textView.smartInsertDeleteType = .no
        textView.spellCheckingType = .no
        textView.alwaysBounceVertical = true
        textView.alwaysBounceHorizontal = true
        textView.keyboardDismissMode = .interactive
        textView.layer.cornerRadius = 0
        textView.layer.borderWidth = 0
        // Keep Runestone's scroll layer from painting behind the fixed file header.
        textView.clipsToBounds = true
        if #available(iOS 16.0, *) {
            textView.isFindInteractionEnabled = true
        }
    }

    private var displayContent: String {
        content.isEmpty ? " " : content
    }

    final class Coordinator {
        var signature: Signature?

        struct Signature: Equatable {
            let content: String
            let languageID: String
            let isDark: Bool
        }
    }
}

private enum WorkspaceRunestoneLanguageResolver {
    static func language(for fileName: String) -> TreeSitterLanguage? {
        switch languageID(for: fileName) {
        case "bash": return .bash
        case "c": return .c
        case "cpp": return .cpp
        case "csharp": return .cSharp
        case "css": return .css
        case "go": return .go
        case "html": return .html
        case "java": return .java
        case "javascript": return .javaScript
        case "jsx": return .jsx
        case "json": return .json
        case "markdown": return .markdown
        case "python": return .python
        case "ruby": return .ruby
        case "rust": return .rust
        case "sql": return .sql
        case "swift": return .swift
        case "toml": return .toml
        case "tsx": return .tsx
        case "typescript": return .typeScript
        case "yaml": return .yaml
        default: return nil
        }
    }

    static func languageID(for fileName: String) -> String {
        let lowercasedName = fileName.lowercased()
        let fileExtension = (lowercasedName as NSString).pathExtension
        let basename = (lowercasedName as NSString).lastPathComponent

        if basename == "dockerfile" {
            return "bash"
        }

        switch fileExtension {
        case "bash", "sh", "zsh": return "bash"
        case "c", "h", "m": return "c"
        case "cc", "cpp", "cxx", "hh", "hpp", "hxx", "mm": return "cpp"
        case "cs": return "csharp"
        case "css", "scss": return "css"
        case "go": return "go"
        case "html", "htm": return "html"
        case "java", "kt": return "java"
        case "js", "mjs", "cjs": return "javascript"
        case "jsx": return "jsx"
        case "json": return "json"
        case "md", "markdown": return "markdown"
        case "py": return "python"
        case "rb": return "ruby"
        case "rs": return "rust"
        case "sql": return "sql"
        case "swift": return "swift"
        case "toml": return "toml"
        case "tsx": return "tsx"
        case "ts": return "typescript"
        case "yaml", "yml": return "yaml"
        default: return "plain"
        }
    }
}

private final class WorkspaceRunestoneTheme: Runestone.Theme {
    private let isDark: Bool

    init(colorScheme: ColorScheme) {
        isDark = colorScheme == .dark
    }

    var font: UIFont {
        AppFont.monoUIFont(size: 13, textStyle: .caption1)
    }

    var textColor: UIColor {
        isDark ? UIColor(red: 0.88, green: 0.91, blue: 0.95, alpha: 1) : .label
    }

    var gutterBackgroundColor: UIColor {
        Self.backgroundUIColor(isDark: isDark)
    }

    var gutterHairlineColor: UIColor {
        UIColor.separator.withAlphaComponent(isDark ? 0.22 : 0.32)
    }

    var lineNumberColor: UIColor {
        UIColor.secondaryLabel.withAlphaComponent(isDark ? 0.70 : 0.82)
    }

    var lineNumberFont: UIFont {
        AppFont.monoUIFont(size: 12, textStyle: .caption2)
    }

    var selectedLineBackgroundColor: UIColor {
        UIColor.systemBlue.withAlphaComponent(isDark ? 0.16 : 0.10)
    }

    var selectedLinesLineNumberColor: UIColor {
        .systemBlue
    }

    var selectedLinesGutterBackgroundColor: UIColor {
        UIColor.systemBlue.withAlphaComponent(isDark ? 0.14 : 0.08)
    }

    var invisibleCharactersColor: UIColor {
        UIColor.tertiaryLabel
    }

    var pageGuideHairlineColor: UIColor {
        UIColor.separator.withAlphaComponent(0.35)
    }

    var pageGuideBackgroundColor: UIColor {
        .clear
    }

    var markedTextBackgroundColor: UIColor {
        UIColor.systemYellow.withAlphaComponent(0.25)
    }

    func textColor(for highlightName: String) -> UIColor? {
        let name = highlightName.lowercased()
        if name.contains("comment") { return isDark ? uiColor(0.45, 0.54, 0.63) : uiColor(0.45, 0.49, 0.55) }
        if name.contains("keyword") || name.contains("operator") { return isDark ? uiColor(0.94, 0.56, 0.76) : uiColor(0.73, 0.18, 0.45) }
        if name.contains("string") { return isDark ? uiColor(0.76, 0.84, 0.55) : uiColor(0.17, 0.55, 0.32) }
        if name.contains("number") || name.contains("constant") { return isDark ? uiColor(0.95, 0.67, 0.46) : uiColor(0.72, 0.38, 0.12) }
        if name.contains("function") || name.contains("method") { return isDark ? uiColor(0.50, 0.74, 1.00) : uiColor(0.00, 0.37, 0.74) }
        if name.contains("type") || name.contains("constructor") { return isDark ? uiColor(0.56, 0.86, 0.78) : uiColor(0.08, 0.52, 0.50) }
        if name.contains("property") || name.contains("field") { return isDark ? uiColor(0.84, 0.70, 1.00) : uiColor(0.43, 0.25, 0.74) }
        if name.contains("variable.builtin") { return isDark ? uiColor(1.00, 0.74, 0.47) : uiColor(0.70, 0.33, 0.08) }
        if name.contains("punctuation") { return UIColor.secondaryLabel }
        return nil
    }

    func fontTraits(for highlightName: String) -> FontTraits {
        let name = highlightName.lowercased()
        if name.contains("keyword") || name.contains("type") {
            return .bold
        }
        return []
    }

    static func backgroundUIColor(for colorScheme: ColorScheme) -> UIColor {
        backgroundUIColor(isDark: colorScheme == .dark)
    }

    private static func backgroundUIColor(isDark: Bool) -> UIColor {
        isDark
            ? UIColor(red: 0.071, green: 0.078, blue: 0.090, alpha: 1)
            : UIColor(red: 0.961, green: 0.965, blue: 0.973, alpha: 1)
    }

    private func uiColor(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> UIColor {
        UIColor(red: red, green: green, blue: blue, alpha: 1)
    }
}
