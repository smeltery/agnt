// FILE: AgntLockScreenWidget.swift
// Purpose: Lock Screen / Always-On accessory widget that surfaces the agnt
//          filled logo. Tapping the widget launches agnt on the host device.
//          Three accessory families are supported so the user can pick the
//          layout that fits their Lock Screen.
// Layer: Widget Extension

import SwiftUI
import WidgetKit

struct AgntLockScreenEntry: TimelineEntry {
    let date: Date
}

struct AgntLockScreenProvider: TimelineProvider {
    func placeholder(in context: Context) -> AgntLockScreenEntry {
        AgntLockScreenEntry(date: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (AgntLockScreenEntry) -> Void) {
        completion(AgntLockScreenEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<AgntLockScreenEntry>) -> Void) {
        // Static branding widget — no time-based refresh required.
        let timeline = Timeline(entries: [AgntLockScreenEntry(date: Date())], policy: .never)
        completion(timeline)
    }
}

struct AgntLockScreenWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: AgntLockScreenEntry

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular:
                circularBody
            case .accessoryRectangular:
                rectangularBody
            case .accessoryInline:
                inlineBody
            default:
                EmptyView()
            }
        }
        .containerBackground(.clear, for: .widget)
    }

    private var circularBody: some View {
        // Keep the circular accessory as a bare glyph; the Lock Screen slot
        // already supplies the surrounding widget chrome.
        Image("agnt_symbol_medium")
            .resizable()
            .renderingMode(.template)
            .scaledToFit()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .widgetAccentable()
    }

    private var rectangularBody: some View {
        HStack(spacing: 8) {
            Image("agnt_symbol_medium")
                .resizable()
                .renderingMode(.template)
                .scaledToFit()
                .frame(width: 28, height: 28)
                .widgetAccentable()

            VStack(alignment: .leading, spacing: 0) {
                Text("agnt")
                    .font(.headline)
                    .lineLimit(1)
                Text("Open agnt chat")
                    .font(.caption)
                    .opacity(0.8)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private var inlineBody: some View {
        // Inline accessories collapse to a single line next to the clock; the
        // image is auto-tinted by the system.
        Label("agnt", image: "agnt_symbol_medium")
    }
}

struct AgntLockScreenWidget: Widget {
    static let kind = "com.smeltery.agnt.AgntMobile.AgntWidget.LockScreen"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: AgntLockScreenProvider()) { entry in
            AgntLockScreenWidgetView(entry: entry)
        }
        .configurationDisplayName("agnt")
        .description("Quick access to agnt from your Lock Screen.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

#if DEBUG
#Preview("Circular", as: .accessoryCircular) {
    AgntLockScreenWidget()
} timeline: {
    AgntLockScreenEntry(date: Date())
}

#Preview("Rectangular", as: .accessoryRectangular) {
    AgntLockScreenWidget()
} timeline: {
    AgntLockScreenEntry(date: Date())
}

#Preview("Inline", as: .accessoryInline) {
    AgntLockScreenWidget()
} timeline: {
    AgntLockScreenEntry(date: Date())
}
#endif
