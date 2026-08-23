package com.smeltery.agnt.mobile.ui.settings

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.smeltery.agnt.mobile.AppContainer
import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.core.model.AppFontStyle
import com.smeltery.agnt.mobile.core.model.AppLanguagePreference
import com.smeltery.agnt.mobile.core.model.AppThemePreference
import com.smeltery.agnt.mobile.core.model.UserBubbleColor
import com.smeltery.agnt.mobile.core.readAgntAppVersionName
import com.smeltery.agnt.mobile.core.transport.ConnectionState
import com.smeltery.agnt.mobile.data.AppFontPreferences
import com.smeltery.agnt.mobile.data.CodexRepository
import com.smeltery.agnt.mobile.data.LanguagePreferences
import com.smeltery.agnt.mobile.data.ThemePreferences
import com.smeltery.agnt.mobile.data.UserBubblePreferences
import com.smeltery.agnt.mobile.ui.theme.agntScreenTopAppBarColors
import com.smeltery.agnt.mobile.ui.theme.bubbleForeground
import com.smeltery.agnt.mobile.ui.theme.swatchColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    repository: CodexRepository,
    onNavigateBack: () -> Unit,
    onNavigateToAbout: () -> Unit,
    onNavigateToWhatsNew: () -> Unit,
    modifier: Modifier = Modifier,
) {
    BackHandler(onBack = onNavigateBack)
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val conn by repository.connectionState.collectAsStateWithLifecycle()
    var fontStyle by remember { mutableStateOf(AppFontPreferences.readFontStyle(context)) }
    var languagePreference by remember { mutableStateOf(LanguagePreferences.read(context)) }
    var themePreference by remember { mutableStateOf(ThemePreferences.read(context)) }
    var bubbleColor by remember { mutableStateOf(UserBubblePreferences.read(context)) }
    var localRelayHostOverride by remember {
        mutableStateOf(AppContainer.sessionPersistence.loadLocalRelayHostOverride().orEmpty())
    }
    val versionName = remember { readAppVersionName(context) }

    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.nav_settings)) },
                colors = agntScreenTopAppBarColors(),
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.cd_navigate_back),
                        )
                    }
                },
            )
        },
    ) { innerPadding ->
        Column(
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
                    .navigationBarsPadding()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            SettingsCard(title = stringResource(R.string.settings_section_appearance)) {
                Text(
                    text = stringResource(R.string.settings_font_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                AppFontStyle.entries.forEach { option ->
                    SettingsOptionRow(
                        selected = option == fontStyle,
                        onClick = {
                            fontStyle = option
                            AppFontPreferences.writeFontStyle(context, option)
                        },
                        title = option.title,
                        subtitle = option.subtitle,
                    )
                }
            }

            SettingsCard(title = stringResource(R.string.settings_language_title)) {
                Text(
                    text = stringResource(R.string.settings_language_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                AppLanguagePreference.entries.forEach { option ->
                    SettingsOptionRow(
                        selected = option == languagePreference,
                        onClick = {
                            languagePreference = option
                            LanguagePreferences.write(context, option)
                        },
                        title = stringResource(settingsLanguageTitleRes(option)),
                        subtitle = stringResource(settingsLanguageSubtitleRes(option)),
                    )
                }
            }

            SettingsCard(title = stringResource(R.string.settings_theme_title)) {
                Text(
                    text = stringResource(R.string.settings_theme_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                AppThemePreference.entries.forEach { option ->
                    SettingsOptionRow(
                        selected = option == themePreference,
                        onClick = {
                            themePreference = option
                            ThemePreferences.write(context, option)
                        },
                        title = stringResource(settingsThemeTitleRes(option)),
                        subtitle = stringResource(settingsThemeSubtitleRes(option)),
                    )
                }
            }

            SettingsCard(title = stringResource(R.string.settings_bubble_color_title)) {
                Text(
                    text = stringResource(R.string.settings_bubble_color_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                SettingsBubbleColorPicker(
                    selected = bubbleColor,
                    onSelect = { option ->
                        bubbleColor = option
                        UserBubblePreferences.write(context, option)
                    },
                )
            }

            SettingsCard(title = stringResource(R.string.settings_section_connection)) {
                SettingsConnectionStatus(conn = conn)
                OutlinedTextField(
                    value = localRelayHostOverride,
                    onValueChange = {
                        localRelayHostOverride = it
                        AppContainer.sessionPersistence.saveLocalRelayHostOverride(it)
                    },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text(stringResource(R.string.settings_local_relay_host_override_label)) },
                    placeholder = { Text(stringResource(R.string.settings_local_relay_host_override_placeholder)) },
                    singleLine = true,
                )
            }

            SettingsCard(title = stringResource(R.string.settings_section_notifications)) {
                SettingsNotificationSection(context = context)
            }

            SettingsCard(title = stringResource(R.string.settings_section_usage)) {
                SettingsUsageRateLimitsSection(repository = repository)
            }

            SettingsCard(title = stringResource(R.string.settings_section_pet)) {
                SettingsPetSection(repository = repository)
            }

            SettingsCard(title = stringResource(R.string.settings_section_about)) {
                SettingsNavigationRow(
                    title = stringResource(R.string.nav_about_agnt),
                    subtitle = stringResource(R.string.settings_about_agnt_hint),
                    onClick = { onNavigateToAbout() },
                )
                SettingsNavigationRow(
                    title = stringResource(R.string.nav_whats_new),
                    subtitle = stringResource(R.string.settings_whats_new_hint),
                    onClick = { onNavigateToWhatsNew() },
                )
                Text(
                    text = stringResource(R.string.settings_about_version, versionName),
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    text = stringResource(R.string.settings_more_coming),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun SettingsCard(
    title: String,
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.46f),
        tonalElevation = 1.dp,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
            )
            content()
        }
    }
}

@Composable
internal fun SettingsOptionRow(
    selected: Boolean,
    onClick: () -> Unit,
    title: String,
    subtitle: String,
) {
    Row(
        modifier =
            Modifier
                .fillMaxWidth()
                .selectable(
                    selected = selected,
                    onClick = onClick,
                    role = Role.RadioButton,
                ).padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(
            selected = selected,
            onClick = null,
        )
        Column(modifier = Modifier.padding(start = 8.dp)) {
            Text(text = title, style = MaterialTheme.typography.bodyLarge)
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SettingsBubbleColorPicker(
    selected: UserBubbleColor,
    onSelect: (UserBubbleColor) -> Unit,
) {
    val selectedLabel = stringResource(settingsBubbleColorLabelRes(selected))
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        UserBubbleColor.entries.forEach { option ->
            val isSelected = option == selected
            val label = stringResource(settingsBubbleColorLabelRes(option))
            Box(
                modifier =
                    Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(option.swatchColor())
                        .border(
                            width = if (isSelected) 2.dp else 1.dp,
                            color =
                                if (isSelected) {
                                    MaterialTheme.colorScheme.primary
                                } else {
                                    MaterialTheme.colorScheme.outline.copy(alpha = 0.42f)
                                },
                            shape = CircleShape,
                        ).selectable(
                            selected = isSelected,
                            onClick = { onSelect(option) },
                            role = Role.RadioButton,
                        ).semantics { contentDescription = label },
                contentAlignment = Alignment.Center,
            ) {
                if (isSelected) {
                    Icon(
                        imageVector = Icons.Filled.Check,
                        contentDescription = null,
                        tint = option.bubbleForeground(MaterialTheme.colorScheme, false),
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
        }
    }
    Text(
        text = stringResource(R.string.settings_bubble_color_selected, selectedLabel),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

private fun settingsBubbleColorLabelRes(color: UserBubbleColor): Int =
    when (color) {
        UserBubbleColor.default -> R.string.settings_bubble_color_default
        UserBubbleColor.orange -> R.string.settings_bubble_color_orange
        UserBubbleColor.yellow -> R.string.settings_bubble_color_yellow
        UserBubbleColor.green -> R.string.settings_bubble_color_green
        UserBubbleColor.blue -> R.string.settings_bubble_color_blue
        UserBubbleColor.pink -> R.string.settings_bubble_color_pink
        UserBubbleColor.purple -> R.string.settings_bubble_color_purple
        UserBubbleColor.black -> R.string.settings_bubble_color_black
    }

@Composable
private fun SettingsNavigationRow(
    title: String,
    subtitle: String,
    onClick: () -> Unit,
) {
    Row(
        modifier =
            Modifier
                .fillMaxWidth()
                .selectable(
                    selected = false,
                    onClick = onClick,
                    role = Role.Button,
                ).padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(text = title, style = MaterialTheme.typography.bodyLarge)
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(modifier = Modifier.width(12.dp))
        Icon(
            imageVector = Icons.AutoMirrored.Filled.ArrowForward,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SettingsConnectionStatus(conn: ConnectionState) {
    val text =
        when (val c = conn) {
            ConnectionState.Offline -> stringResource(R.string.sidebar_bridge_offline)
            ConnectionState.Connecting -> stringResource(R.string.sidebar_bridge_connecting)
            ConnectionState.Connected -> stringResource(R.string.sidebar_bridge_connected)
            is ConnectionState.Error -> stringResource(R.string.sidebar_bridge_error, c.message)
        }
    Text(
        text = text,
        style = MaterialTheme.typography.bodyMedium,
    )
}

private fun settingsThemeTitleRes(option: AppThemePreference): Int =
    when (option) {
        AppThemePreference.system -> R.string.settings_theme_system_title
        AppThemePreference.light -> R.string.settings_theme_light_title
        AppThemePreference.dark -> R.string.settings_theme_dark_title
    }

private fun settingsThemeSubtitleRes(option: AppThemePreference): Int =
    when (option) {
        AppThemePreference.system -> R.string.settings_theme_system_subtitle
        AppThemePreference.light -> R.string.settings_theme_light_subtitle
        AppThemePreference.dark -> R.string.settings_theme_dark_subtitle
    }

private fun settingsLanguageTitleRes(option: AppLanguagePreference): Int =
    when (option) {
        AppLanguagePreference.english -> R.string.settings_language_english_title
        AppLanguagePreference.system -> R.string.settings_language_system_title
    }

private fun settingsLanguageSubtitleRes(option: AppLanguagePreference): Int =
    when (option) {
        AppLanguagePreference.english -> R.string.settings_language_english_subtitle
        AppLanguagePreference.system -> R.string.settings_language_system_subtitle
    }

private fun readAppVersionName(context: Context): String = readAgntAppVersionName(context)

internal fun openSystemNotificationSettings(context: Context) {
    val appPackage = Uri.fromParts("package", context.packageName, null)
    val intent =
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    runCatching { context.startActivity(intent) }
        .recoverCatching {
            context.startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = appPackage
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                },
            )
        }
}
