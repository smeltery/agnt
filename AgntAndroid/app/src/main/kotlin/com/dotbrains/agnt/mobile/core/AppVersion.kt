package com.dotbrains.agnt.mobile.core

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

private const val AGNT_APP_VERSION_FALLBACK = "0.1.0"

fun readAgntAppVersionName(context: Context): String =
    try {
        val appContext = context.applicationContext
        val pm = appContext.packageManager
        val pkg = appContext.packageName
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0)).versionName
                ?: AGNT_APP_VERSION_FALLBACK
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(pkg, 0).versionName ?: AGNT_APP_VERSION_FALLBACK
        }
    } catch (_: Exception) {
        AGNT_APP_VERSION_FALLBACK
    }
