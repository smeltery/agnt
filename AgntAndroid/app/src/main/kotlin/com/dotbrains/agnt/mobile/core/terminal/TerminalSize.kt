package com.dotbrains.agnt.mobile.core.terminal

/**
 * Viewport size in character cells. Mirrors the upstream Stivy-01/remodex
 * `TerminalSize` so the native (Termux) renderer can talk to the rest of the
 * terminal pipeline without translating to a `(cols, rows)` pair at every call
 * site. `normalized` clamps to the same bounds the bridge enforces.
 */
data class TerminalSize(
    val cols: Int,
    val rows: Int,
) {
    val normalized: TerminalSize
        get() =
            TerminalSize(
                cols = cols.coerceIn(2, 400),
                rows = rows.coerceIn(2, 200),
            )
}
