package com.smeltery.agnt.mobile.core.config

import com.smeltery.agnt.mobile.BuildConfig

object FeatureFlags {
    val designModeEnabled: Boolean
        get() = BuildConfig.DEBUG
}
