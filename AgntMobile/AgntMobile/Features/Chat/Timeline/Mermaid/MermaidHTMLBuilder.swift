// FILE: MermaidHTMLBuilder.swift
// Purpose: HTML document generation for bundled Mermaid rendering.
// Layer: View Support

import Foundation

enum MermaidHTMLBuilder {
    static func html(source: String, isDarkMode: Bool) -> String {
        let sourceJSON = jsonStringLiteral(source)
        let configJSON = jsonObjectLiteral(configuration(isDarkMode: isDarkMode))
        // Mirrors the in-app mono picker when Mermaid falls back to raw source text.
        let monoFontFamily = AppFont.webMonospaceFontStack

        return """
        <!doctype html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
          <style>
            :root {
              color-scheme: \(isDarkMode ? "dark" : "light");
            }
            html, body {
              margin: 0;
              padding: 0;
              background: transparent;
            }
            body {
              font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
              overflow: hidden;
            }
            #diagram {
              width: 100%;
            }
            #diagram svg {
              width: 100%;
              height: auto;
              display: block;
            }
            #fallback {
              display: none;
              margin: 0;
              white-space: pre-wrap;
              font: 13px/1.45 \(monoFontFamily);
              color: \(isDarkMode ? "#F5F5F5" : "#1A1A1A");
            }
          </style>
          <script src="mermaid.min.js"></script>
        </head>
        <body>
          <div id="diagram"></div>
          <pre id="fallback"></pre>
          <script>
            const source = \(sourceJSON);
            const config = \(configJSON);
            const diagram = document.getElementById("diagram");
            const fallback = document.getElementById("fallback");

            function reportHeight() {
              const height = Math.ceil(
                Math.max(
                  document.body.scrollHeight,
                  document.documentElement.scrollHeight,
                  diagram.getBoundingClientRect().height,
                  fallback.getBoundingClientRect().height
                )
              );
              if (window.webkit?.messageHandlers?.mermaidHeight) {
                window.webkit.messageHandlers.mermaidHeight.postMessage(height);
              }
            }

            async function renderDiagram() {
              try {
                mermaid.initialize(config);
                const result = await mermaid.render("mermaid-" + Math.random().toString(36).slice(2), source);
                diagram.innerHTML = result.svg;
                fallback.style.display = "none";
              } catch (error) {
                diagram.innerHTML = "";
                fallback.textContent = source;
                fallback.style.display = "block";
              }

              requestAnimationFrame(() => {
                reportHeight();
                setTimeout(reportHeight, 40);
              });
            }

            window.addEventListener("load", renderDiagram);
            window.addEventListener("resize", reportHeight);
          </script>
        </body>
        </html>
        """
    }

    static func fallbackHTML(source: String) -> String {
        let sourceJSON = jsonStringLiteral(source)
        // Keeps the standalone fallback page aligned with the selected mono family too.
        let monoFontFamily = AppFont.webMonospaceFontStack
        return """
        <!doctype html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
          <style>
            html, body {
              margin: 0;
              padding: 0;
              background: transparent;
            }
            body {
              white-space: pre-wrap;
              font: 13px/1.45 \(monoFontFamily);
              color: #F5F5F5;
            }
          </style>
        </head>
        <body><script>document.write(\(sourceJSON).replace(/</g, "&lt;"));</script></body>
        </html>
        """
    }

    private static func configuration(isDarkMode: Bool) -> [String: Any] {
        [
            "startOnLoad": false,
            "securityLevel": "strict",
            "theme": "base",
            "fontFamily": "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            "flowchart": [
                "useMaxWidth": true,
                "htmlLabels": true,
                "curve": "basis"
            ],
            "themeVariables": themeVariables(isDarkMode: isDarkMode)
        ]
    }

    private static func themeVariables(isDarkMode: Bool) -> [String: String] {
        if isDarkMode {
            return [
                "background": "transparent",
                "primaryColor": "#132033",
                "primaryBorderColor": "#456FAD",
                "primaryTextColor": "#EAF2FF",
                "secondaryColor": "#152A27",
                "secondaryBorderColor": "#3B8C7C",
                "secondaryTextColor": "#E7FFF9",
                "tertiaryColor": "#25153F",
                "tertiaryBorderColor": "#7554C7",
                "tertiaryTextColor": "#F3EDFF",
                "lineColor": "#8EA0B8",
                "textColor": "#F5F7FB"
            ]
        }

        return [
            "background": "transparent",
            "primaryColor": "#E8F0FF",
            "primaryBorderColor": "#4F6FB0",
            "primaryTextColor": "#13284A",
            "secondaryColor": "#E7F6F1",
            "secondaryBorderColor": "#3E8C79",
            "secondaryTextColor": "#173B33",
            "tertiaryColor": "#F1EAFE",
            "tertiaryBorderColor": "#7A57C4",
            "tertiaryTextColor": "#321C63",
            "lineColor": "#65758B",
            "textColor": "#142033"
        ]
    }

    private static func jsonStringLiteral(_ value: String) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let literal = String(data: data, encoding: .utf8) else {
            return "\"\""
        }
        return literal
    }

    private static func jsonObjectLiteral(_ value: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: []),
              let literal = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return literal
    }
}

