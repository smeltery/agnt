package com.smeltery.agnt.mobile.ui

import androidx.compose.runtime.staticCompositionLocalOf
import com.smeltery.agnt.mobile.core.persistence.AIChangeSetPersistence
import com.smeltery.agnt.mobile.data.CodexRepository

val LocalCodexRepository =
    staticCompositionLocalOf<CodexRepository> {
        error("CodexRepository not provided — wrap content in CompositionLocalProvider from MainActivity")
    }

val LocalAIChangeSetPersistence =
    staticCompositionLocalOf<AIChangeSetPersistence> {
        error("AIChangeSetPersistence not provided — wrap content in CompositionLocalProvider from MainActivity")
    }
