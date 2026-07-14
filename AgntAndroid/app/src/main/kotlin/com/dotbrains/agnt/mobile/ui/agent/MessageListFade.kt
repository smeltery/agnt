package com.dotbrains.agnt.mobile.ui.agent

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

internal val MessageListTopFadeStart = 108.dp
internal val MessageListTopFadeLength = 76.dp

internal fun Modifier.topContentFadeMask(
    fadeStart: Dp,
    fadeLength: Dp,
): Modifier =
    this
        .graphicsLayer {
            compositingStrategy = CompositingStrategy.Offscreen
        }.drawWithContent {
            drawContent()
            if (size.height <= 0f) return@drawWithContent
            val height = size.height
            if (height <= 1f) return@drawWithContent
            val fadeStartPx = fadeStart.toPx().coerceIn(0f, height - 1f)
            val fadeEndPx =
                (fadeStartPx + fadeLength.toPx().coerceAtLeast(1f))
                    .coerceAtMost(height)
            val fadeStartStop = (fadeStartPx / size.height).coerceIn(0f, 1f)
            val fadeEndStop = (fadeEndPx / size.height).coerceIn(0f, 1f)
            drawRect(
                brush =
                    Brush.verticalGradient(
                        colorStops =
                            arrayOf(
                                0f to Color.Transparent,
                                fadeStartStop to Color.Transparent,
                                fadeEndStop to Color.Black,
                                1f to Color.Black,
                            ),
                        startY = 0f,
                        endY = size.height,
                    ),
                blendMode = BlendMode.DstIn,
            )
        }
