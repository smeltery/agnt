plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ktlint) apply false
}

tasks.register("ciDebug") {
    group = "verification"
    description = "Run the Android debug checks used by GitHub Actions."
    dependsOn(":app:ktlintCheck", ":app:testDebugUnitTest", ":app:assembleDebug")
}
