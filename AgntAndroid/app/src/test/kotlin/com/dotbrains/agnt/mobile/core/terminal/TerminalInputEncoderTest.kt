package com.dotbrains.agnt.mobile.core.terminal

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals

class TerminalInputEncoderTest {
    @Test
    fun ctrlLetterEncodesControlByte() {
        assertContentEquals(byteArrayOf(3), TerminalInputEncoder.text("c", TerminalModifier.Ctrl))
        assertContentEquals(byteArrayOf(1), TerminalInputEncoder.text("A", TerminalModifier.Ctrl))
    }

    @Test
    fun plainTextEncodesUtf8() {
        assertEquals("git status", TerminalInputEncoder.text("git status").decodeToString())
    }

    @Test
    fun arrowsEncodeEscapeSequences() {
        assertEquals("\u001B[A", TerminalInputEncoder.direction(TerminalDirection.Up).decodeToString())
        assertEquals(
            "\u001B[1;5D",
            TerminalInputEncoder.direction(TerminalDirection.Left, TerminalModifier.Ctrl).decodeToString(),
        )
        assertEquals(
            "\u001B[1;3C",
            TerminalInputEncoder.direction(TerminalDirection.Right, TerminalModifier.Alt).decodeToString(),
        )
    }
}
