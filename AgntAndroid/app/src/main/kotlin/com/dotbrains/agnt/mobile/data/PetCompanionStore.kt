package com.dotbrains.agnt.mobile.data

import android.content.Context
import com.dotbrains.agnt.mobile.core.model.PetCompanion
import com.dotbrains.agnt.mobile.core.model.PetCompanionPosition
import com.dotbrains.agnt.mobile.core.model.PetCompanionStatusSnapshot
import com.dotbrains.agnt.mobile.services.agent.pet.listPets
import com.dotbrains.agnt.mobile.services.agent.pet.readPet
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex

/**
 * Persists and loads the optional companion pet state (parity iOS
 * `PetCompanionStore`). Metadata is loaded first; only the selected pet's
 * spritesheet atlas is hydrated to keep memory and relay payloads small.
 *
 * State is exposed as [StateFlow]s so Compose can observe it; persistence is a
 * dedicated SharedPreferences file (not the protocol layer).
 */
class PetCompanionStore(
    private val context: Context,
) {
    private object Keys {
        const val PREFS = "agnt_pet"
        const val ENABLED = "pet.isEnabled"
        const val SELECTED_ID = "pet.selectedId"
        const val POSITION_X = "pet.positionX"
        const val POSITION_Y = "pet.positionY"
    }

    private fun prefs() = context.applicationContext.getSharedPreferences(Keys.PREFS, Context.MODE_PRIVATE)

    private val _isEnabled = MutableStateFlow(prefs().getBoolean(Keys.ENABLED, false))
    val isEnabled: StateFlow<Boolean> = _isEnabled.asStateFlow()

    private val _selectedPetId = MutableStateFlow(prefs().getString(Keys.SELECTED_ID, null))
    val selectedPetId: StateFlow<String?> = _selectedPetId.asStateFlow()

    private val _position = MutableStateFlow(readPosition())
    val position: StateFlow<PetCompanionPosition> = _position.asStateFlow()

    private val _availablePets = MutableStateFlow<List<PetCompanion>>(emptyList())
    val availablePets: StateFlow<List<PetCompanion>> = _availablePets.asStateFlow()

    private val _renderedPet = MutableStateFlow<PetCompanion?>(null)
    val renderedPet: StateFlow<PetCompanion?> = _renderedPet.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()

    private val loadMutex = Mutex()

    /** Currently selected pet, falling back to the first available one. */
    val selectedPet: PetCompanion?
        get() {
            val id = _selectedPetId.value
            if (id != null) {
                _availablePets.value.firstOrNull { it.id == id }?.let { return it }
            }
            return _availablePets.value.firstOrNull()
        }

    fun setEnabled(enabled: Boolean) {
        if (_isEnabled.value == enabled) return
        _isEnabled.value = enabled
        prefs().edit().putBoolean(Keys.ENABLED, enabled).apply()
    }

    fun selectPet(id: String?) {
        if (_selectedPetId.value == id) return
        _selectedPetId.value = id
        prefs().edit().putString(Keys.SELECTED_ID, id).apply()
        _renderedPet.value = null
    }

    fun updatePosition(position: PetCompanionPosition) {
        _position.value = position
        prefs()
            .edit()
            .putFloat(Keys.POSITION_X, position.normalizedX.toFloat())
            .putFloat(Keys.POSITION_Y, position.normalizedY.toFloat())
            .apply()
    }

    /** Clears hydrated/in-memory pet state on disconnect; persisted prefs survive. */
    fun reset() {
        _availablePets.value = emptyList()
        _renderedPet.value = null
        _errorMessage.value = null
    }

    suspend fun loadPetsIfNeeded(repository: CodexRepository) {
        if (_availablePets.value.isNotEmpty()) return
        refreshPets(repository)
    }

    suspend fun refreshPets(repository: CodexRepository) {
        if (!repository.isSessionReady.value) {
            _errorMessage.value = "Connect to your Mac to load local pets."
            return
        }
        if (!loadMutex.tryLock()) return
        try {
            _isLoading.value = true
            val pets = repository.listPets(includeData = false)
            _availablePets.value = pets
            _errorMessage.value = null

            val currentId = _selectedPetId.value
            if (currentId == null || pets.none { it.id == currentId }) {
                _selectedPetId.value = pets.firstOrNull()?.id
                prefs().edit().putString(Keys.SELECTED_ID, _selectedPetId.value).apply()
                _renderedPet.value = null
            }
        } catch (error: Throwable) {
            _errorMessage.value = error.message
        } finally {
            _isLoading.value = false
            loadMutex.unlock()
        }
        loadSelectedPet(repository)
    }

    suspend fun loadSelectedPet(repository: CodexRepository) {
        if (!repository.isSessionReady.value) return
        val pet = selectedPet
        if (pet == null) {
            _renderedPet.value = null
            return
        }
        val rendered = _renderedPet.value
        if (rendered?.id == pet.id && !rendered.spritesheetDataUrl.isNullOrEmpty()) return

        try {
            val loaded = repository.readPet(pet.id)
            // Drop a late result if the selection changed while loading.
            if (_selectedPetId.value == null || _selectedPetId.value == pet.id) {
                _renderedPet.value = loaded
                _errorMessage.value = null
            }
        } catch (error: Throwable) {
            if (_selectedPetId.value == null || _selectedPetId.value == pet.id) {
                _renderedPet.value = null
                _errorMessage.value = error.message
            }
        }
    }

    private fun readPosition(): PetCompanionPosition {
        val p = prefs()
        if (!p.contains(Keys.POSITION_X) || !p.contains(Keys.POSITION_Y)) {
            return PetCompanionPosition.Default
        }
        return PetCompanionPosition(
            normalizedX = p.getFloat(Keys.POSITION_X, PetCompanionPosition.Default.normalizedX.toFloat()).toDouble(),
            normalizedY = p.getFloat(Keys.POSITION_Y, PetCompanionPosition.Default.normalizedY.toFloat()).toDouble(),
        )
    }
}

/** Holds the resolved status pill so the overlay reads a single flow. */
class PetCompanionStatusStore {
    private val _snapshot = MutableStateFlow(PetCompanionStatusSnapshot.Idle)
    val snapshot: StateFlow<PetCompanionStatusSnapshot> = _snapshot.asStateFlow()

    fun update(snapshot: PetCompanionStatusSnapshot) {
        if (_snapshot.value != snapshot) _snapshot.value = snapshot
    }

    fun reset() = update(PetCompanionStatusSnapshot.Idle)
}
