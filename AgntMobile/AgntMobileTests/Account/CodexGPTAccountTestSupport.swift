// FILE: CodexGPTAccountTestSupport.swift
// Purpose: Provides shared fixtures for ChatGPT account tests.
// Layer: Unit Test Support
// Exports: CodexGPTAccountTestCase
// Depends on: XCTest, AgntMobile

import Foundation
import XCTest
@testable import AgntMobile

@MainActor
class CodexGPTAccountTestCase: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func makeService() -> CodexService {
        let service = CodexService(defaults: makeDefaults())
        Self.retainedServices.append(service)
        return service
    }

    func makeDefaults() -> UserDefaults {
        let suiteName = "CodexGPTAccountTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }

    func yieldMainActor(times: Int) async {
        for _ in 0..<times {
            await Task.yield()
        }
    }

    func makeTemporaryVoiceClipURL() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("wav")
        try makeTestWavData().write(to: url)
        return url
    }

    func makeTestWavData() -> Data {
        let sampleRate = 24_000
        let sampleCount = sampleRate / 4
        let pcmData = Data(repeating: 0, count: sampleCount * 2)
        let dataSize = UInt32(pcmData.count)

        var wav = Data()
        wav.append(contentsOf: "RIFF".utf8)
        wav.appendLE(UInt32(36 + dataSize))
        wav.append(contentsOf: "WAVE".utf8)
        wav.append(contentsOf: "fmt ".utf8)
        wav.appendLE(UInt32(16))
        wav.appendLE(UInt16(1))
        wav.appendLE(UInt16(1))
        wav.appendLE(UInt32(sampleRate))
        wav.appendLE(UInt32(sampleRate * 2))
        wav.appendLE(UInt16(2))
        wav.appendLE(UInt16(16))
        wav.append(contentsOf: "data".utf8)
        wav.appendLE(dataSize)
        wav.append(pcmData)
        return wav
    }

    func XCTAssertThrowsErrorAsync<T>(
        _ expression: () async throws -> T,
        _ errorHandler: (Error) -> Void
    ) async {
        do {
            _ = try await expression()
            XCTFail("Expected expression to throw")
        } catch {
            errorHandler(error)
        }
    }
}

private extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { rawBuffer in
            append(contentsOf: rawBuffer.bindMemory(to: UInt8.self))
        }
    }
}
