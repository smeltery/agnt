package com.dotbrains.agnt.mobile.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

/** Shared rounded “pill / capsule” language aligned with iOS agnt references. */
val AgntShapes: Shapes =
    Shapes(
        extraSmall = RoundedCornerShape(10.dp),
        small = RoundedCornerShape(14.dp),
        medium = RoundedCornerShape(18.dp),
        large = RoundedCornerShape(22.dp),
        extraLarge = RoundedCornerShape(28.dp),
    )

val AgntComposerCapsuleShape: RoundedCornerShape = RoundedCornerShape(24.dp)
val AgntToolbarIconShape: RoundedCornerShape = RoundedCornerShape(20.dp)
