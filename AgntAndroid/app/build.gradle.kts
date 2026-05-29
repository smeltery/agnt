import java.io.FileInputStream
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ktlint)
}

ktlint {
    // Pin a recent ktlint version explicitly so the formatter doesn't drift
    // out from under us when the Gradle plugin updates. Compose-aware rules
    // are included by default in 1.x.
    version.set("1.4.1")
    android.set(true)
    // Build output should fail loudly on style violations (the whole point of
    // wiring this into :check), but skip the build-generated Kotlin that AGP
    // emits under build/ — we don't own that source.
    filter {
        exclude { entry -> entry.file.path.contains("/build/") }
    }
}

val keystorePropertiesFile = rootProject.file("key.properties")
val keystoreProperties =
    Properties().apply {
        if (keystorePropertiesFile.exists()) {
            load(FileInputStream(keystorePropertiesFile))
        }
    }
val hasReleaseSigning =
    keystorePropertiesFile.exists() &&
        listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
            .all { key -> !keystoreProperties.getProperty(key).isNullOrBlank() }

android {
    namespace = "com.dotbrains.agnt.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.dotbrains.agnt.mobile"
        minSdk = 26
        targetSdk = 36

        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = rootProject.file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            pickFirsts += "META-INF/versions/9/OSGI-INF/MANIFEST.MF"
        }
    }
}

gradle.taskGraph.whenReady {
    val releasePackagingTaskRequested =
        allTasks.any { task ->
            task.project == project &&
                task.name.endsWith("Release") &&
                (
                    task.name.startsWith("assemble") ||
                        task.name.startsWith("bundle") ||
                        task.name.startsWith("package")
                )
        }

    if (releasePackagingTaskRequested && !hasReleaseSigning) {
        throw GradleException("Missing android/key.properties for release signing")
    }
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    exclude("**/ui/design/**")
}

dependencies {
    // Mike Penz markdown 0.39.x targets Kotlin 2.2 / newer runtime APIs (e.g.
    // Updater.init-impl); older Compose BOMs still pin runtime 1.9.4 →
    // NoSuchMethodError. The BOM in libs.versions.toml is the source of truth
    // for the unversioned androidx.compose.* coordinates below.
    implementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(platform(libs.androidx.compose.bom))

    implementation(libs.androidx.webkit)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.core.ktx)
    implementation(libs.material)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.compose.material.iconsExtended)
    implementation(libs.icons.lucide)
    implementation(libs.shimmer)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)

    // Native terminal renderer used by TermuxTerminalSurface as a low-overhead
    // alternative to the WebView+xterm.js path. Apache-2.0 (jackpal Android
    // Terminal Emulator lineage); resolved via JitPack.
    implementation(libs.termux.terminal.view)
    implementation(libs.termux.terminal.emulator)

    implementation(libs.markdown.renderer)
    implementation(libs.markdown.renderer.m3)
    implementation(libs.markdown.renderer.code)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.androidx.security.crypto)
    implementation(libs.bouncycastle.bcprov)

    // SSH client for the on-device terminal (parity with Citadel on iOS).
    implementation(libs.sshj)

    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode.scanning)

    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.kotlinx.serialization.json)
    testImplementation(libs.okhttp.mockwebserver)
}
