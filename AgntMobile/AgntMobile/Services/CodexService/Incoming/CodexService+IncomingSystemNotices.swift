// FILE: CodexService+IncomingSystemNotices.swift
// Purpose: Bridge-level system notice parsing and toast queue management.
// Layer: Service
// Exports: CodexService system notice helpers
// Depends on: Foundation, JSONValue

import Foundation

extension CodexService {
    func handleSystemNotice(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject else { return }

        let title = trimmedSystemNoticeString(paramsObject["title"]?.stringValue)
        let message = trimmedSystemNoticeString(paramsObject["message"]?.stringValue)
        guard title != nil || message != nil else { return }

        let severity = CodexSystemNoticeSeverity(rawBridgeValue: paramsObject["severity"]?.stringValue)
        let notice = CodexSystemNotice(
            severity: severity,
            title: title,
            message: message,
            provider: trimmedSystemNoticeString(paramsObject["provider"]?.stringValue),
            threadId: trimmedSystemNoticeString(paramsObject["threadId"]?.stringValue)
        )

        systemNotices.append(notice)
        scheduleSystemNoticeDismiss(
            notice,
            durationNanoseconds: systemNoticeDurationNanoseconds(
                from: paramsObject["durationMs"],
                severity: severity
            )
        )
    }

    func dismissSystemNotice(id: UUID) {
        systemNoticeDismissTasksByID.removeValue(forKey: id)?.cancel()
        systemNotices.removeAll { $0.id == id }
    }

    func clearSystemNotices() {
        for task in systemNoticeDismissTasksByID.values {
            task.cancel()
        }
        systemNoticeDismissTasksByID.removeAll()
        systemNotices.removeAll()
    }

    private func scheduleSystemNoticeDismiss(
        _ notice: CodexSystemNotice,
        durationNanoseconds: UInt64
    ) {
        systemNoticeDismissTasksByID.removeValue(forKey: notice.id)?.cancel()
        let task = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: durationNanoseconds)
            guard !Task.isCancelled else { return }
            self?.dismissSystemNotice(id: notice.id)
        }
        systemNoticeDismissTasksByID[notice.id] = task
    }

    private func systemNoticeDurationNanoseconds(
        from value: JSONValue?,
        severity: CodexSystemNoticeSeverity
    ) -> UInt64 {
        let durationMs = value?.intValue ?? value?.doubleValue.map(Int.init)
        guard let durationMs, durationMs > 0 else {
            return severity.defaultDurationNanoseconds
        }
        return UInt64(durationMs) * 1_000_000
    }

    private func trimmedSystemNoticeString(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}
