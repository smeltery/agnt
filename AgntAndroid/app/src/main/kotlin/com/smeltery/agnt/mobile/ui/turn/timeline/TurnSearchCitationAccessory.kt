package com.smeltery.agnt.mobile.ui.turn.timeline

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.ui.turn.autocomplete.SkillReferenceFormatter
import com.smeltery.agnt.mobile.ui.turn.diff.TurnTimelineLeadSlotWidth
import com.valentinilk.shimmer.shimmer

private const val ChevronCollapsedDegrees = 0f
private const val ChevronExpandedDegrees = 90f
private val SearchCitationDotSize = TurnTimelineLeadSlotWidth / 2

@Composable
internal fun TurnSearchCitationAccessory(
    markdown: String,
    isStreaming: Boolean,
    modifier: Modifier = Modifier,
) {
    val citations = remember(markdown) { SkillReferenceFormatter.extractSearchCitations(markdown) }
    if (citations.isEmpty()) return

    var expanded by rememberSaveable(markdown) { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    val showDetails = stringResource(R.string.turn_search_citations_show)
    val hideDetails = stringResource(R.string.turn_search_citations_hide)
    val rowDescription = if (expanded) hideDetails else showDetails

    Column(
        modifier =
            modifier
                .then(if (isStreaming) Modifier.shimmer() else Modifier),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .clip(MaterialTheme.shapes.small)
                    .semantics {
                        contentDescription = rowDescription
                        role = Role.Button
                    }.clickable { expanded = !expanded }
                    .padding(vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SearchCitationLeadAligned()
            Spacer(Modifier.width(8.dp))
            Text(
                text = stringResource(R.string.turn_search_citations_title),
                style = MaterialTheme.typography.bodyMedium,
                color = colors.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Icon(
                imageVector = Icons.Rounded.ChevronRight,
                contentDescription = null,
                tint = colors.onSurfaceVariant.copy(alpha = 0.5f),
                modifier =
                    Modifier
                        .padding(start = 6.dp)
                        .size(22.dp)
                        .rotate(if (expanded) ChevronExpandedDegrees else ChevronCollapsedDegrees),
            )
        }

        if (expanded) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                citations.forEach { citation ->
                    SearchCitationFileNameRow(name = citationDisplayName(citation))
                }
            }
        }
    }
}

@Composable
private fun SearchCitationFileNameRow(name: String) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier =
            Modifier
                .fillMaxWidth()
                .padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SearchCitationLeadAligned()
        Spacer(Modifier.width(8.dp))
        Text(
            text = name,
            style = MaterialTheme.typography.bodyMedium,
            fontFamily = FontFamily.Monospace,
            color = colors.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun SearchCitationLeadAligned() {
    Box(
        modifier = Modifier.width(TurnTimelineLeadSlotWidth),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier =
                Modifier
                    .size(SearchCitationDotSize)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.secondary),
        )
    }
}

private fun citationDisplayName(ref: String): String =
    ref
        .trim()
        .takeIf { it.isNotEmpty() }
        ?: "search"
