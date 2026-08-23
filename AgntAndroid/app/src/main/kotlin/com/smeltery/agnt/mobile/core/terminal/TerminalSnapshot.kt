package com.smeltery.agnt.mobile.core.terminal

/**
 * Status enum mirrored from `AgntTerminalStatus`
 * (`AgntMobile/AgntMobile/Services/Terminal/AgntTerminalModels.swift`).
 */
enum class TerminalStatus(
    val displayTitle: String,
) {
    Idle("Idle"),
    Starting("Connecting"),
    Running("Running"),
    Exited("Exited"),
    Closed("Closed"),
    Error("Error"),
    ;

    val isRunning: Boolean
        get() = this == Starting || this == Running
}

/**
 * Live snapshot of an SSH terminal session.
 * Mirrors `AgntTerminalSnapshot` from the iOS service layer.
 */
data class TerminalSnapshot(
    val terminalId: String,
    val instanceId: String?,
    val status: TerminalStatus,
    val bufferData: ByteArray,
    val cwd: String,
    val cols: Int,
    val rows: Int,
    val errorMessage: String?,
    val resizeSupported: Boolean,
) {
    fun appendingOutput(data: ByteArray): TerminalSnapshot {
        if (data.isEmpty()) return this
        val combined =
            if (bufferData.size + data.size <= MAX_BUFFER_BYTES) {
                bufferData + data
            } else {
                val merged = bufferData + data
                merged.copyOfRange(merged.size - MAX_BUFFER_BYTES, merged.size)
            }
        return copy(bufferData = combined)
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is TerminalSnapshot) return false
        return terminalId == other.terminalId &&
            instanceId == other.instanceId &&
            status == other.status &&
            bufferData.contentEquals(other.bufferData) &&
            cwd == other.cwd &&
            cols == other.cols &&
            rows == other.rows &&
            errorMessage == other.errorMessage &&
            resizeSupported == other.resizeSupported
    }

    override fun hashCode(): Int {
        var result = terminalId.hashCode()
        result = 31 * result + (instanceId?.hashCode() ?: 0)
        result = 31 * result + status.hashCode()
        result = 31 * result + bufferData.contentHashCode()
        result = 31 * result + cwd.hashCode()
        result = 31 * result + cols.hashCode()
        result = 31 * result + rows.hashCode()
        result = 31 * result + (errorMessage?.hashCode() ?: 0)
        result = 31 * result + resizeSupported.hashCode()
        return result
    }

    companion object {
        const val DEFAULT_TERMINAL_ID = "term-1"
        private const val MAX_BUFFER_BYTES = 200_000

        fun idle(terminalId: String = DEFAULT_TERMINAL_ID): TerminalSnapshot =
            TerminalSnapshot(
                terminalId = terminalId,
                instanceId = null,
                status = TerminalStatus.Idle,
                bufferData = ByteArray(0),
                cwd = "",
                cols = 80,
                rows = 24,
                errorMessage = null,
                resizeSupported = false,
            )
    }
}
