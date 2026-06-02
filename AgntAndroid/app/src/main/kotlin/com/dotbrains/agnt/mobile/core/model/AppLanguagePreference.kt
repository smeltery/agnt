package com.dotbrains.agnt.mobile.core.model

enum class AppLanguagePreference {
    english,
    system,
    ;

    companion object {
        const val storageKey: String = "agnt.appLanguage"

        val default: AppLanguagePreference = english

        fun fromStorage(raw: String?): AppLanguagePreference =
            if (raw.isNullOrBlank()) {
                default
            } else {
                runCatching { valueOf(raw) }.getOrDefault(default)
            }
    }
}
