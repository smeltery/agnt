pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Termux terminal-view + terminal-emulator (Apache-2.0, jackpal lineage)
        // are only published via JitPack at coords com.termux.termux-app:*.
        maven("https://jitpack.io")
    }
}

rootProject.name = "AgntMobile"
include(":app")
