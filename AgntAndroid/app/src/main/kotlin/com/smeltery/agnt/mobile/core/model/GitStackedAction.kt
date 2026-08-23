package com.smeltery.agnt.mobile.core.model

data class GitStackedActionProgressEvent(
    val progressId: String,
    val phase: String,
    val status: String,
)

data class GitPullRequestActionResult(
    val status: String,
    val url: String?,
    val number: Int?,
    val title: String,
) {
    val createdOrOpened: Boolean
        get() = status == "created" || status == "opened_existing"

    companion object {
        fun fromJson(json: RPCObject?): GitPullRequestActionResult? {
            if (json == null) return null
            val status = json["status"]?.stringValue?.trim().orEmpty()
            if (status.isEmpty() || status == "skipped_not_requested") return null
            return GitPullRequestActionResult(
                status = status,
                url = json["url"]?.stringValue?.trim()?.takeIf { it.isNotEmpty() },
                number = json["number"]?.intValue,
                title = json["title"]?.stringValue?.trim().orEmpty(),
            )
        }
    }
}

data class GitRunStackedActionResult(
    val action: String,
    val pullRequest: GitPullRequestActionResult?,
    val status: GitRepoSyncResult?,
) {
    companion object {
        fun fromJson(json: RPCObject): GitRunStackedActionResult =
            GitRunStackedActionResult(
                action = json["action"]?.stringValue?.trim().orEmpty(),
                pullRequest = GitPullRequestActionResult.fromJson(json["pr"]?.objectValue),
                status = json["status"]?.objectValue?.let { GitRepoSyncResult.fromJson(it) },
            )
    }
}
