package com.dotbrains.agnt.mobile.core.config

import com.dotbrains.agnt.mobile.BuildConfig

object FeatureFlags {
    val designModeEnabled: Boolean
        get() = BuildConfig.DEBUG
}
