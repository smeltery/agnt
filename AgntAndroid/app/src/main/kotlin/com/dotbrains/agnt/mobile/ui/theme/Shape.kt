package com.dotbrains.agnt.mobile.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

/** Shared rounded “pill / capsule” language aligned with iOS agnt references. */
val AgntShapes: Shapes =
    Shapes(
        extraSmall = RoundedCornerShape(8.dp),
        small = RoundedCornerShape(12.dp),
        medium = RoundedCornerShape(14.dp),
        large = RoundedCornerShape(18.dp),
        extraLarge = RoundedCornerShape(26.dp),
    )

val AgntComposerCapsuleShape: RoundedCornerShape = RoundedCornerShape(26.dp)
val AgntToolbarIconShape: RoundedCornerShape = RoundedCornerShape(20.dp)
