package com.dotbrains.agnt.mobile.ui.onboarding

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.dotbrains.agnt.mobile.AppContainer
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.model.CodexPairingQRPayload
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.data.QrPairingValidationResult
import com.dotbrains.agnt.mobile.data.validatePairingQrCode
import com.dotbrains.agnt.mobile.pairing.LoopbackRelayException
import com.dotbrains.agnt.mobile.pairing.applyQrPayloadAndConnect
import com.dotbrains.agnt.mobile.ui.dev.PairingQrScanner
import com.dotbrains.agnt.mobile.ui.home.BridgeUpdateSheet
import kotlinx.coroutines.launch

@Composable
fun QrScannerScreen(
    repository: CodexRepository,
    onBack: () -> Unit,
    onPairingComplete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    // Hoisted out of scope.launch / non-Composable callbacks so they re-cache on configuration change.
    val cameraDeniedMessage = stringResource(R.string.qr_scanner_camera_denied)
    val pairingValidMessage = stringResource(R.string.qr_scanner_valid)
    var statusMessage by remember { mutableStateOf<String?>(null) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var connecting by remember { mutableStateOf(false) }
    var bridgeUpdateTitle by remember { mutableStateOf("") }
    var bridgeUpdateMessage by remember { mutableStateOf("") }
    var bridgeUpdateCommand by remember { mutableStateOf<String?>(null) }
    var bridgeUpdateVisible by remember { mutableStateOf(false) }
    var scanEnabled by remember { mutableStateOf(true) }
    var pendingPayload by remember { mutableStateOf<CodexPairingQRPayload?>(null) }
    var scannerResetNonce by remember { mutableStateOf(0) }
    var manualPairingDialogVisible by remember { mutableStateOf(false) }
    var manualPairingText by remember { mutableStateOf("") }

    fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED

    var cameraPermissionGranted by remember { mutableStateOf(hasCameraPermission()) }

    fun resetScanner() {
        pendingPayload = null
        scanEnabled = true
        statusMessage = null
        errorMessage = null
        bridgeUpdateTitle = ""
        bridgeUpdateMessage = ""
        bridgeUpdateCommand = null
        bridgeUpdateVisible = false
        scannerResetNonce += 1
    }

    val permissionLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            cameraPermissionGranted = granted || hasCameraPermission()
            if (cameraPermissionGranted) {
                resetScanner()
            } else {
                errorMessage = cameraDeniedMessage
            }
        }

    DisposableEffect(lifecycleOwner, context) {
        val observer =
            LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_RESUME) {
                    val granted = hasCameraPermission()
                    cameraPermissionGranted = granted
                    if (granted) {
                        resetScanner()
                    }
                }
            }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }

    fun runConnect(payload: CodexPairingQRPayload) {
        scope.launch {
            connecting = true
            errorMessage = null
            statusMessage = pairingValidMessage
            try {
                applyQrPayloadAndConnect(
                    repository = repository,
                    sessionPersistence = AppContainer.sessionPersistence,
                    secureStore = AppContainer.secureStore,
                    payload = payload,
                    relayHostOverride = "",
                    tokenOverride = "",
                )
                onPairingComplete()
            } catch (e: LoopbackRelayException) {
                errorMessage = e.message
                pendingPayload = null
            } catch (e: Exception) {
                errorMessage = e.message ?: e::class.simpleName
                pendingPayload = null
            } finally {
                connecting = false
            }
        }
    }

    fun handlePairingResult(result: QrPairingValidationResult) {
        when (result) {
            is QrPairingValidationResult.Success -> {
                pendingPayload = result.payload
                scanEnabled = false
                manualPairingDialogVisible = false
                runConnect(result.payload)
            }
            is QrPairingValidationResult.ShortCode -> {
                scanEnabled = false
                errorMessage = "Use Enter pairing code for the short code from your desktop."
            }
            is QrPairingValidationResult.ScanError -> {
                scanEnabled = false
                errorMessage = result.message
            }
            is QrPairingValidationResult.BridgeUpdateRequired -> {
                scanEnabled = false
                bridgeUpdateTitle = result.title
                bridgeUpdateMessage = result.message
                bridgeUpdateCommand = result.command
                bridgeUpdateVisible = true
            }
        }
    }

    fun submitManualPairing() {
        scope.launch {
            val manualInput = parseManualPairingInput(manualPairingText)
            val raw = manualInput.codeOrPayload
            if (raw.isEmpty()) {
                errorMessage = "Enter the pairing code from your desktop."
                return@launch
            }
            errorMessage = null
            statusMessage = "Resolving pairing code"
            connecting = true
            try {
                when (val directResult = validatePairingQrCode(raw)) {
                    is QrPairingValidationResult.Success -> {
                        connecting = false
                        handlePairingResult(directResult)
                    }
                    is QrPairingValidationResult.BridgeUpdateRequired -> {
                        connecting = false
                        handlePairingResult(directResult)
                    }
                    is QrPairingValidationResult.ShortCode -> {
                        val resolved = resolveManualPairingCode(context, directResult.code)
                        connecting = false
                        handlePairingResult(resolved)
                    }
                    is QrPairingValidationResult.ScanError -> {
                        val resolved = resolveManualPairingCode(context, raw, manualInput.relayUrl)
                        connecting = false
                        handlePairingResult(resolved)
                    }
                }
            } catch (e: Exception) {
                connecting = false
                errorMessage = e.message ?: e::class.simpleName
            }
        }
    }

    Surface(
        modifier = modifier.fillMaxSize(),
        color = Color(0xFFF4F3F1),
        contentColor = Color(0xFF151515),
    ) {
        Column(
            modifier =
                Modifier
                    .fillMaxSize()
                    .statusBarsPadding()
                    .navigationBarsPadding()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 18.dp, vertical = 14.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            QrScannerHeader(onBack = onBack)

            Spacer(modifier = Modifier.height(14.dp))

            Box(
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .aspectRatio(0.64f)
                        .clip(RoundedCornerShape(22.dp))
                        .background(Color(0xFF3B332C)),
            ) {
                if (!cameraPermissionGranted) {
                    PermissionPrompt(
                        onGrantCamera = { permissionLauncher.launch(Manifest.permission.CAMERA) },
                        modifier = Modifier.align(Alignment.Center),
                    )
                } else {
                    if (scanEnabled && pendingPayload == null) {
                        key(scannerResetNonce) {
                            PairingQrScanner(
                                modifier = Modifier.matchParentSize(),
                                onDecodedPayload = { raw ->
                                    errorMessage = null
                                    handlePairingResult(validatePairingQrCode(raw))
                                },
                            )
                        }
                    }
                    QrScannerOverlay(
                        connecting = connecting,
                        statusMessage = statusMessage,
                        errorMessage = errorMessage,
                        onScanAgain = ::resetScanner,
                    )
                }
            }

            Spacer(modifier = Modifier.height(36.dp))

            Button(
                onClick = { manualPairingDialogVisible = true },
                enabled = !connecting,
            ) {
                Text("Enter pairing code")
            }

            Spacer(modifier = Modifier.height(18.dp))

            Image(
                painter = painterResource(R.drawable.agnt_icon),
                contentDescription = null,
                modifier = Modifier.size(92.dp),
            )
        }
    }

    BridgeUpdateSheet(
        visible = bridgeUpdateVisible,
        title = bridgeUpdateTitle,
        message = bridgeUpdateMessage,
        installCommand = bridgeUpdateCommand,
        onDismiss = {
            bridgeUpdateVisible = false
            bridgeUpdateCommand = null
            resetScanner()
        },
        onRetry = {
            bridgeUpdateVisible = false
            bridgeUpdateCommand = null
            resetScanner()
        },
        onScanNewQr = {
            bridgeUpdateVisible = false
            bridgeUpdateCommand = null
            resetScanner()
        },
    )

    if (manualPairingDialogVisible) {
        AlertDialog(
            onDismissRequest = { if (!connecting) manualPairingDialogVisible = false },
            title = { Text("Pair manually") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(
                        value = manualPairingText,
                        onValueChange = { manualPairingText = it },
                        label = { Text("Pairing code") },
                        placeholder = { Text("ABCDEFGHJK") },
                        singleLine = false,
                        minLines = 2,
                        enabled = !connecting,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = ::submitManualPairing,
                    enabled = !connecting,
                ) {
                    Text("Connect")
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { manualPairingDialogVisible = false },
                    enabled = !connecting,
                ) {
                    Text("Cancel")
                }
            },
        )
    }
}
