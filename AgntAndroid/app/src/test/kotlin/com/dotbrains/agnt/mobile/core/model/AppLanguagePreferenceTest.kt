package com.dotbrains.agnt.mobile.core.model

import kotlin.test.Test
import kotlin.test.assertEquals

class AppLanguagePreferenceTest {
    @Test
    fun defaultPreferenceUsesEnglish() {
        assertEquals(AppLanguagePreference.english, AppLanguagePreference.default)
        assertEquals(AppLanguagePreference.english, AppLanguagePreference.fromStorage(null))
        assertEquals(AppLanguagePreference.english, AppLanguagePreference.fromStorage(""))
        assertEquals(AppLanguagePreference.english, AppLanguagePreference.fromStorage("unknown"))
    }

    @Test
    fun storedPreferenceIsRestoredWhenValid() {
        assertEquals(AppLanguagePreference.english, AppLanguagePreference.fromStorage("english"))
        assertEquals(AppLanguagePreference.system, AppLanguagePreference.fromStorage("system"))
    }
}
