package com.dotbrains.agnt.mobile.ui.turn.composer

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.ui.theme.AgentLightColors
import com.dotbrains.agnt.mobile.ui.turn.autocomplete.TurnComposerAutocompleteItem
import com.dotbrains.agnt.mobile.ui.turn.autocomplete.TurnComposerAutocompleteState
import com.composables.icons.lucide.R as LucideR

@Composable
internal fun ComposerAutocompletePopup(
    state: TurnComposerAutocompleteState?,
    lightChrome: Boolean,
    onSelectAutocomplete: (TurnComposerAutocompleteItem) -> Unit,
) {
    val visibleState = state?.takeIf { it.isVisible } ?: return
    val autoShape = MaterialTheme.shapes.small
    val autoBg =
        if (lightChrome) {
            AgentLightColors.Surface.copy(alpha = 0.96f)
        } else {
            MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.85f)
        }
    val autoModifier =
        if (lightChrome) {
            Modifier.border(
                width = 1.dp,
                color = MaterialTheme.colorScheme.outline,
                shape = autoShape,
            )
        } else {
            Modifier
        }
    Surface(
        modifier = autoModifier.heightIn(max = 280.dp),
        shape = autoShape,
        color = autoBg,
    ) {
        Column(
            modifier =
                Modifier
                    .padding(horizontal = 8.dp, vertical = 6.dp)
                    .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = visibleState.title,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (visibleState.isLoading && visibleState.items.isEmpty()) {
                ComposerAutocompleteLoadingRow()
            }
            visibleState.items.forEach { item ->
                ComposerAutocompleteItemRow(
                    item = item,
                    onSelectAutocomplete = onSelectAutocomplete,
                )
            }
        }
    }
}

@Composable
private fun ComposerAutocompleteLoadingRow() {
    Row(
        modifier =
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(18.dp),
            strokeWidth = 2.dp,
        )
        Text(
            text = stringResource(R.string.turn_runtime_loading),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun ComposerAutocompleteItemRow(
    item: TurnComposerAutocompleteItem,
    onSelectAutocomplete: (TurnComposerAutocompleteItem) -> Unit,
) {
    Row(
        modifier =
            Modifier
                .fillMaxWidth()
                .clip(MaterialTheme.shapes.extraSmall)
                .clickable { onSelectAutocomplete(item) }
                .padding(horizontal = 8.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painter = painterResource(autocompleteIconRes(item.payload.kind)),
            contentDescription = null,
            modifier = Modifier.size(18.dp),
            tint = autocompleteIconTint(item.payload.kind),
        )
        Column(modifier = Modifier.fillMaxWidth()) {
            Text(
                text = item.title,
                color = autocompleteTitleTint(item.payload.kind),
                style = MaterialTheme.typography.bodyMedium,
            )
            item.subtitle?.let { subtitle ->
                Text(
                    text = subtitle,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun autocompleteIconTint(kind: ComposerMentionKind): Color =
    when (kind) {
        ComposerMentionKind.Skill -> MaterialTheme.colorScheme.primary
        ComposerMentionKind.Plugin -> MaterialTheme.colorScheme.tertiary
        ComposerMentionKind.File -> MaterialTheme.colorScheme.onSurfaceVariant
        ComposerMentionKind.SlashCommand -> MaterialTheme.colorScheme.secondary
    }

@Composable
private fun autocompleteTitleTint(kind: ComposerMentionKind): Color =
    when (kind) {
        ComposerMentionKind.Skill -> MaterialTheme.colorScheme.primary
        ComposerMentionKind.Plugin -> MaterialTheme.colorScheme.onSurface
        ComposerMentionKind.File,
        ComposerMentionKind.SlashCommand,
        -> MaterialTheme.colorScheme.onSurface
    }

private fun autocompleteIconRes(kind: ComposerMentionKind): Int =
    when (kind) {
        ComposerMentionKind.File -> LucideR.drawable.lucide_ic_file
        ComposerMentionKind.Skill -> LucideR.drawable.lucide_ic_square_asterisk
        ComposerMentionKind.Plugin -> LucideR.drawable.lucide_ic_blocks
        ComposerMentionKind.SlashCommand -> LucideR.drawable.lucide_ic_command
    }
