// FILE: OnboardingView.swift
// Purpose: Split onboarding flow — swipeable pages with fixed bottom bar.
// Layer: View
// Exports: OnboardingView
// Depends on: SwiftUI, OnboardingWelcomePage, OnboardingFeaturesPage, OnboardingStepPage

import SwiftUI

struct OnboardingView: View {
    let onContinue: () -> Void
    @State private var currentPage = 0
    @State private var isShowingAgentInstallReminder = false

    private let pageCount = 5
    private let agentInstallStepIndex = 2
    // agnt works with any supported coding agent; Codex is shown as the example.
    private let agentInstallExampleCommand = "npm install -g @openai/codex@latest"

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                TabView(selection: $currentPage) {
                    OnboardingWelcomePage()
                        .tag(0)

                    OnboardingFeaturesPage()
                        .tag(1)

                    OnboardingStepPage(
                        stepNumber: 1,
                        icon: "terminal",
                        title: "Install a coding agent",
                        description: "agnt drives a coding agent on your computer — Codex, Claude Code, opencode, or Cursor. Install whichever you use; the command below sets up Codex.",
                        command: agentInstallExampleCommand,
                        commandCaption: "Prefer Claude Code? Run `npm install -g @anthropic-ai/claude-code`. opencode and Cursor ship their own installers."
                    )
                    .tag(2)

                    OnboardingStepPage(
                        stepNumber: 2,
                        icon: "link",
                        title: "Install the Bridge",
                        description: "A lightweight relay that securely connects your computer to your iPhone.",
                        command: "npm install -g @dotbrains/agnt@latest",
                        commandCaption: "agnt can keep your computer awake while the bridge is running, but it starts disabled by default. You can enable it later in Settings if you want."
                    )
                    .tag(3)

                    OnboardingStepPage(
                        stepNumber: 3,
                        icon: "qrcode.viewfinder",
                        title: "Start Pairing",
                        description: "Run this on your computer. A QR code will appear in your terminal — scan it next.",
                        command: "agnt up"
                    )
                    .tag(4)
                }
                .tabViewStyle(.page(indexDisplayMode: .never))

                bottomBar
            }
        }
        .preferredColorScheme(.dark)
        .alert("Install a coding agent first", isPresented: $isShowingAgentInstallReminder) {
            Button("Stay Here", role: .cancel) {}
            Button("Continue Anyway") {
                advanceToNextPage()
            }
        } message: {
            Text("Install one of the supported coding agents (Codex, Claude Code, opencode, or Cursor) on your computer before moving on. agnt will not work until a coding agent is installed and available in your PATH.")
        }
    }

    // MARK: - Bottom bar

    private var bottomBar: some View {
        VStack(spacing: 20) {
            // Animated pill dots
            HStack(spacing: 8) {
                ForEach(0..<pageCount, id: \.self) { i in
                    Capsule()
                        .fill(i == currentPage ? Color.white : Color.white.opacity(0.18))
                        .frame(width: i == currentPage ? 24 : 8, height: 8)
                }
            }
            .animation(.spring(response: 0.35, dampingFraction: 0.8), value: currentPage)

            // CTA button
            PrimaryCapsuleButton(
                title: buttonTitle,
                systemImage: currentPage == pageCount - 1 ? "qrcode" : nil,
                action: handleContinue
            )

            SourceBadge(style: .light)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
        .background(
            LinearGradient(
                colors: [.clear, .black.opacity(0.6), .black],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 50)
            .offset(y: -50),
            alignment: .top
        )
    }

    // MARK: - State

    private var buttonTitle: String {
        switch currentPage {
        case 0: return "Get Started"
        case 1: return "Set Up"
        case pageCount - 1: return "Scan QR Code"
        default: return "Continue"
        }
    }

    private func handleContinue() {
        // Installing a coding agent is a hard requirement, so warn before advancing.
        if currentPage == agentInstallStepIndex {
            isShowingAgentInstallReminder = true
            return
        }

        if currentPage < pageCount - 1 {
            advanceToNextPage()
        } else {
            onContinue()
        }
    }

    private func advanceToNextPage() {
        withAnimation(.easeInOut(duration: 0.3)) {
            currentPage += 1
        }
    }
}

// MARK: - Previews

#Preview("Full Flow") {
    OnboardingView {
        print("Continue tapped")
    }
}

#Preview("Light Override") {
    OnboardingView {
        print("Continue tapped")
    }
    .preferredColorScheme(.light)
}
