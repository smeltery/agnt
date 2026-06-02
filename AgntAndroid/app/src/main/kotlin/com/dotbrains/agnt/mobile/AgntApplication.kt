package com.dotbrains.agnt.mobile

import android.app.Application
import com.dotbrains.agnt.mobile.core.notification.AgntLocalNotificationPresenter
import com.dotbrains.agnt.mobile.core.notification.AppForegroundTracker
import com.dotbrains.agnt.mobile.core.persistence.SharedPrefsMigration
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.Security

class AgntApplication : Application() {
    override fun onCreate() {
        Security.insertProviderAt(BouncyCastleProvider(), 1)
        super.onCreate()
        // Rebrand legacy `remodex_*` prefs into the `agnt_*` namespace before any pref-backed
        // service reads them in AppContainer.initialize. Idempotent / no-op after first launch.
        SharedPrefsMigration.runIfNeeded(this)
        AppForegroundTracker.register()
        AppContainer.initialize(this)
        AgntLocalNotificationPresenter.ensureChannelCreated(this)
    }
}
