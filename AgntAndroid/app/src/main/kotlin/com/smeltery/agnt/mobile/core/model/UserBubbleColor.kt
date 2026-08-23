package com.smeltery.agnt.mobile.core.model

enum class UserBubbleColor {
    default,
    orange,
    yellow,
    green,
    blue,
    pink,
    purple,
    black,
    ;

    companion object {
        const val storageKey: String = "agnt.userBubbleColor"
        val defaultValue: UserBubbleColor = default

        fun fromStorage(raw: String?): UserBubbleColor =
            if (raw.isNullOrBlank()) {
                defaultValue
            } else {
                runCatching { valueOf(raw) }.getOrDefault(defaultValue)
            }
    }
}
