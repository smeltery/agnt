package com.dotbrains.agnt.mobile

import android.app.Application
import com.dotbrains.agnt.mobile.core.notification.AgntLocalNotificationPresenter
import com.dotbrains.agnt.mobile.core.notification.AppForegroundTracker
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.Security

class AgntApplication : Application() {
    override fun onCreate() {
        Security.insertProviderAt(BouncyCastleProvider(), 1)
        super.onCreate()
        AppForegroundTracker.register()
        AppContainer.initialize(this)
        AgntLocalNotificationPresenter.ensureChannelCreated(this)
    }
}
