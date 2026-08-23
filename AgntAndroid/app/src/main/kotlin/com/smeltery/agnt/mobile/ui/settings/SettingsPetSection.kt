package com.smeltery.agnt.mobile.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.smeltery.agnt.mobile.AppContainer
import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.data.CodexRepository
import kotlinx.coroutines.launch

@Composable
internal fun SettingsPetSection(repository: CodexRepository) {
    val store = AppContainer.petCompanionStore
    val scope = rememberCoroutineScope()
    val isEnabled by store.isEnabled.collectAsStateWithLifecycle()
    val availablePets by store.availablePets.collectAsStateWithLifecycle()
    val selectedPetId by store.selectedPetId.collectAsStateWithLifecycle()
    val isLoading by store.isLoading.collectAsStateWithLifecycle()
    val errorMessage by store.errorMessage.collectAsStateWithLifecycle()
    val ready by repository.isSessionReady.collectAsStateWithLifecycle()

    LaunchedEffect(isEnabled, ready) {
        if (isEnabled && ready) store.loadPetsIfNeeded(repository)
    }

    Text(
        text = stringResource(R.string.settings_pet_hint),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = stringResource(R.string.settings_pet_enable_title),
                style = MaterialTheme.typography.bodyLarge,
            )
        }
        Switch(
            checked = isEnabled,
            onCheckedChange = { enabled ->
                store.setEnabled(enabled)
                if (enabled && ready) {
                    scope.launch { store.refreshPets(repository) }
                }
            },
        )
    }

    if (isEnabled) {
        when {
            !ready ->
                Text(
                    text = stringResource(R.string.settings_pet_connect_first),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            isLoading ->
                Text(
                    text = stringResource(R.string.settings_pet_loading),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            availablePets.isEmpty() ->
                Text(
                    text = errorMessage ?: stringResource(R.string.settings_pet_empty),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            else ->
                availablePets.forEach { pet ->
                    SettingsOptionRow(
                        selected = pet.id == (selectedPetId ?: availablePets.firstOrNull()?.id),
                        onClick = {
                            store.selectPet(pet.id)
                            scope.launch { store.loadSelectedPet(repository) }
                        },
                        title = pet.displayName,
                        subtitle = pet.description ?: stringResource(R.string.settings_pet_default_description),
                    )
                }
        }
        if (ready) {
            TextButton(onClick = { scope.launch { store.refreshPets(repository) } }) {
                Text(stringResource(R.string.settings_pet_refresh))
            }
        }
    }
}
