// FILE: MermaidBlockView.swift
// Purpose: Interactive Mermaid block snapshot display and save/preview affordances.
// Layer: View Support

import SwiftUI
import UIKit

struct MermaidBlockView: View {
    let source: String

    @Environment(\.colorScheme) private var colorScheme
    @State private var resolvedSnapshot: MermaidRenderedSnapshot?
    @State private var renderHeight: CGFloat = 160
    @State private var availableWidth: CGFloat = 0
    @State private var previewImage: PreviewImagePayload?
    @State private var saveCoordinator = ImageSaveCoordinator()
    @State private var saveAlertMessage: String?

    var body: some View {
        Group {
            if let snapshot = currentSnapshot {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    previewImage = PreviewImagePayload(image: snapshot.image, title: "Diagram")
                } label: {
                    Image(uiImage: snapshot.image)
                        .resizable()
                        .interpolation(.high)
                        .scaledToFit()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .frame(height: max(snapshot.height, 120))
                }
                .buttonStyle(.plain)
            } else if renderDescriptor != nil {
                MermaidSnapshotRenderer(
                    source: source,
                    descriptor: renderDescriptor,
                    renderHeight: $renderHeight
                ) { snapshot in
                    resolvedSnapshot = snapshot
                }
                .frame(maxWidth: .infinity)
                .frame(height: max(renderHeight, 120))
            } else {
                MermaidPlaceholderView()
                    .frame(maxWidth: .infinity)
                    .frame(height: max(renderHeight, 120))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
        )
        .overlay(alignment: .topTrailing) {
            if let snapshot = currentSnapshot {
                saveButton(for: snapshot)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(.secondarySystemBackground).opacity(0.35))
        )
        .background(widthReader)
        .onAppear(perform: refreshCachedSnapshot)
        .onChange(of: availableWidth) { _, _ in
            refreshCachedSnapshot()
        }
        .onChange(of: colorScheme) { _, _ in
            refreshCachedSnapshot()
        }
        .onChange(of: source) { _, _ in
            refreshCachedSnapshot()
        }
        .fullScreenCover(item: $previewImage) { payload in
            ZoomableImagePreviewScreen(
                payload: payload,
                onDismiss: { previewImage = nil }
            )
        }
        .alert("Image", isPresented: saveAlertIsPresented, actions: {
            Button("OK", role: .cancel) {
                saveAlertMessage = nil
            }
        }, message: {
            Text(saveAlertMessage ?? "")
        })
    }

    private var renderDescriptor: MermaidRenderDescriptor? {
        guard availableWidth > 1 else {
            return nil
        }
        return MermaidRenderDescriptor(
            source: MermaidSourceNormalizer.normalized(source),
            isDarkMode: colorScheme == .dark,
            targetWidth: availableWidth
        )
    }

    private var currentSnapshot: MermaidRenderedSnapshot? {
        if let resolvedSnapshot {
            return resolvedSnapshot
        }
        guard let descriptor = renderDescriptor else {
            return nil
        }
        return MermaidRenderedSnapshotCache.snapshot(for: descriptor)
    }

    private var widthReader: some View {
        GeometryReader { geometry in
            Color.clear
                .onAppear {
                    updateWidth(geometry.size.width)
                }
                .onChange(of: geometry.size.width) { _, width in
                    updateWidth(width)
                }
        }
    }

    private func updateWidth(_ width: CGFloat) {
        let normalizedWidth = max(0, floor(width))
        guard abs(normalizedWidth - availableWidth) > 0.5 else {
            return
        }
        availableWidth = normalizedWidth
    }

    private func refreshCachedSnapshot() {
        guard let descriptor = renderDescriptor else {
            resolvedSnapshot = nil
            renderHeight = 160
            return
        }

        if let cached = MermaidRenderedSnapshotCache.snapshot(for: descriptor) {
            resolvedSnapshot = cached
            renderHeight = cached.height
        } else {
            resolvedSnapshot = nil
            renderHeight = max(MermaidRenderedSnapshotCache.knownHeight(for: descriptor) ?? 160, 120)
        }
    }

    private func saveSnapshot(_ snapshot: MermaidRenderedSnapshot) {
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        saveCoordinator.save(snapshot.image) { result in
            switch result {
            case .success:
                saveAlertMessage = "Saved to Photos."
            case .failure(let error):
                saveAlertMessage = error.localizedDescription
            }
        }
    }

    private func saveButton(for snapshot: MermaidRenderedSnapshot) -> some View {
        Button {
            saveSnapshot(snapshot)
        } label: {
            Image(systemName: "square.and.arrow.down")
                .font(AppFont.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.96))
                .padding(9)
                .background(
                    Circle()
                        .fill(Color.black.opacity(0.48))
                )
        }
        .buttonStyle(.plain)
        .padding(.top, 10)
        .padding(.trailing, 10)
        .accessibilityLabel("Save diagram")
    }

    private var saveAlertIsPresented: Binding<Bool> {
        Binding(
            get: { saveAlertMessage != nil },
            set: { isPresented in
                if !isPresented {
                    saveAlertMessage = nil
                }
            }
        )
    }
}

