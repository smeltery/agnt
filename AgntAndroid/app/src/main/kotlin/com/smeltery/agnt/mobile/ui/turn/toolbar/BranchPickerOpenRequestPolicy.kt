package com.smeltery.agnt.mobile.ui.turn.toolbar

internal enum class BranchPickerCloseCause {
    UserDismissed,
    BranchSelected,
    BranchCreated,
    StateInvalidated,
}

internal fun shouldConsumeBranchPickerOpenRequest(cause: BranchPickerCloseCause): Boolean = cause != BranchPickerCloseCause.StateInvalidated
