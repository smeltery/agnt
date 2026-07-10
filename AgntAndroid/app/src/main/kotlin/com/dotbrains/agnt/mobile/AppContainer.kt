package com.dotbrains.agnt.mobile

import android.content.Context
import com.dotbrains.agnt.mobile.core.persistence.AIChangeSetPersistence
import com.dotbrains.agnt.mobile.core.persistence.CodexMessagePersistence
import com.dotbrains.agnt.mobile.core.persistence.SessionPersistence
import com.dotbrains.agnt.mobile.core.security.SecureStore
import com.dotbrains.agnt.mobile.core.shortcut.AgntShortcutAction
import com.dotbrains.agnt.mobile.core.terminal.TerminalController
import com.dotbrains.agnt.mobile.core.terminal.TerminalKnownHostStore
import com.dotbrains.agnt.mobile.core.terminal.TerminalPrivateKeyStore
import com.dotbrains.agnt.mobile.core.terminal.TerminalProfileStore
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.data.PetCompanionStore
import com.dotbrains.agnt.mobile.services.agent.AgentService
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** Application-wide services (secure store, persistence, OkHttp, bridge client). */
object AppContainer {
    private val pendingNotificationThreadLock = Any()
    private val pendingShortcutLock = Any()

    @Volatile
    private var pendingNotificationThreadId: String? = null

    @Volatile
    private var pendingShortcutAction: AgntShortcutAction? = null

    private val shortcutLaunchEvents = MutableSharedFlow<AgntShortcutAction>(extraBufferCapacity = 1)
    val shortcutLaunches = shortcutLaunchEvents.asSharedFlow()

    /** Set when the user taps a local notification ([AgntLocalNotificationPresenter]). */
    fun setPendingOpenThreadFromNotification(threadId: String?) {
        val t = threadId?.trim()?.takeIf { it.isNotEmpty() } ?: return
        synchronized(pendingNotificationThreadLock) {
            pendingNotificationThreadId = t
        }
    }

    fun consumePendingOpenThreadFromNotification(): String? =
        synchronized(pendingNotificationThreadLock) {
            val v = pendingNotificationThreadId
            pendingNotificationThreadId = null
            v
        }

    fun publishShortcutLaunch(action: AgntShortcutAction) {
        synchronized(pendingShortcutLock) {
            pendingShortcutAction = action
        }
        shortcutLaunchEvents.tryEmit(action)
    }

    fun consumePendingShortcutLaunch(): AgntShortcutAction? =
        synchronized(pendingShortcutLock) {
            val v = pendingShortcutAction
            pendingShortcutAction = null
            v
        }

    lateinit var appContext: Context
        private set

    lateinit var secureStore: SecureStore
        private set

    lateinit var messagePersistence: CodexMessagePersistence
        private set

    lateinit var aiChangeSetPersistence: AIChangeSetPersistence
        private set

    lateinit var sessionPersistence: SessionPersistence
        private set

    lateinit var httpClient: OkHttpClient
        private set

    lateinit var httpCallClient: OkHttpClient
        private set

    lateinit var codexRepository: CodexRepository
        private set

    lateinit var terminalController: TerminalController
        private set

    /** Optional companion-pet state; shared by the shell overlay and Settings. */
    lateinit var petCompanionStore: PetCompanionStore
        private set

    fun initialize(context: Context) {
        val app = context.applicationContext
        appContext = app
        secureStore = SecureStore(app)
        messagePersistence = CodexMessagePersistence(app, secureStore)
        aiChangeSetPersistence = AIChangeSetPersistence(app)
        sessionPersistence = SessionPersistence(secureStore, app)
        httpCallClient =
            OkHttpClient
                .Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .writeTimeout(20, TimeUnit.SECONDS)
                .callTimeout(30, TimeUnit.SECONDS)
                .retryOnConnectionFailure(false)
                .build()
        httpClient =
            httpCallClient
                .newBuilder()
                .pingInterval(30, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS)
                .callTimeout(0, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build()
        codexRepository =
            AgentService(
                context = app,
                httpClient = httpClient,
                httpCallClient = httpCallClient,
                secureStore = secureStore,
                sessionPersistence = sessionPersistence,
                messagePersistence = messagePersistence,
            )
        terminalController =
            TerminalController(
                profileStore = TerminalProfileStore(secureStore),
                privateKeyStore = TerminalPrivateKeyStore(secureStore),
                knownHostStore = TerminalKnownHostStore(secureStore),
            )
        petCompanionStore = PetCompanionStore(app)
    }
}
