#!/usr/bin/env bash
set -euo pipefail

manual_scope="${INPUT_SCOPE:-}"
event_name="${GITHUB_EVENT_NAME:-}"

if [[ -n "${CHANGED_FILES_OVERRIDE:-}" ]]; then
  changed_files="$CHANGED_FILES_OVERRIDE"
elif [[ "$event_name" == "schedule" ]]; then
  changed_files="__scheduled_link_check__"
elif [[ "$event_name" == "workflow_dispatch" && "$manual_scope" == "all" ]]; then
  changed_files="__all__"
elif [[ "$event_name" == "workflow_dispatch" ]]; then
  changed_files="__manual_${manual_scope}__"
elif [[ "$event_name" == "pull_request" ]]; then
  changed_files="$(git diff --name-only "$PR_BASE_SHA" "$GITHUB_SHA")"
else
  if [[ "$PUSH_BEFORE_SHA" =~ ^0+$ ]]; then
    changed_files="$(git diff-tree --no-commit-id --name-only -r "$GITHUB_SHA")"
  else
    changed_files="$(git diff --name-only "$PUSH_BEFORE_SHA" "$GITHUB_SHA")"
  fi
fi

{
  echo "Changed files:"
  printf '%s\n' "$changed_files"
} >> "$GITHUB_STEP_SUMMARY"

matches() {
  local pattern="$1"
  [[ "$changed_files" == "__all__" ]] || printf '%s\n' "$changed_files" | grep -Eq "$pattern"
}

requested() {
  local surface="$1"
  [[ "$event_name" == "workflow_dispatch" ]] || return 1
  [[ "$manual_scope" == "all" || "$manual_scope" == "$surface" ]] && return 0
  [[ "$manual_scope" == "bun" && "$surface" =~ ^(bridge|relay|web|host)$ ]]
}

should_run() {
  local surface="$1"
  local pattern="$2"
  requested "$surface" || matches "$pattern"
}

set_output() {
  local name="$1"
  local value="$2"
  echo "$name=$value" >> "$GITHUB_OUTPUT"
  echo "$name: $value" >> "$GITHUB_STEP_SUMMARY"
}

ci_config='^(\.github/workflows/|\.github/actions/|\.github/scripts/|\.github/actionlint\.ya?ml)'
link_check_action='^\.github/actions/run-link-check/'
setup_bun_action='^\.github/actions/setup-bun-package/'
android_ci_action='^\.github/actions/run-android-ci/'
ios_ipa_action='^\.github/actions/build-unsigned-ios-ipa/'
flox_config='^\.flox/'
flox_common="$flox_config"
bun_common="$flox_common|$setup_bun_action"
secure_bridge='^agnt-bridge/src/(transport/)?secure-transport\.js'
secure_web='^agnt-web/src/crypto/'
secure_ios='^(AgntMobile/AgntMobile/Core/Networking/CodexSecureTransportModels\.swift|AgntMobile/AgntMobile/Services/CodexService/Transport/CodexService\+SecureTransport\.swift)'
secure_android='^(AgntAndroid/app/src/main/kotlin/com/dotbrains/agnt/mobile/core/model/SecureTransportModels\.kt|AgntAndroid/app/src/main/kotlin/com/dotbrains/agnt/mobile/core/crypto/)'
# These files implement one shared encrypted transport contract across clients.
# Any change fans out to every parity surface that can compile-test it.
secure_transport="$secure_bridge|$secure_web|$secure_ios|$secure_android"
android_code='^(AgntAndroid/(app|gradle)/|AgntAndroid/(build\.gradle\.kts|settings\.gradle\.kts|gradle\.properties|gradlew|gradlew\.bat))'

bun_packages=()

if matches "$ci_config"; then set_output lint_workflows true; else set_output lint_workflows false; fi

if should_run bridge "$bun_common|$secure_transport|^agnt-bridge/"; then
  bun_packages+=('{"name":"agnt-bridge","working-directory":"agnt-bridge","frozen-lockfile":"true","audit":"true"}')
fi

if should_run relay "$bun_common|^relay/"; then
  bun_packages+=('{"name":"relay","working-directory":"relay","frozen-lockfile":"true","audit":"true"}')
fi

if should_run web "$bun_common|$secure_transport|^agnt-web/"; then
  bun_packages+=('{"name":"agnt-web","working-directory":"agnt-web","frozen-lockfile":"true","audit":"true"}')
fi

if should_run android "$android_ci_action|$flox_common|$secure_transport|$android_code"; then set_output android true; else set_output android false; fi

if should_run host "$bun_common|^agnt-host/"; then
  # agnt-host does not commit a Bun lockfile yet.
  bun_packages+=('{"name":"agnt-host","working-directory":"agnt-host","frozen-lockfile":"false","audit":"false"}')
fi

if should_run ios "$ios_ipa_action|$secure_transport|^AgntMobile/"; then set_output ios true; else set_output ios false; fi

if [[ "$event_name" == "schedule" ]] || requested links || matches "$link_check_action|^.*\.md$|^\.lycheeignore$"; then
  set_output links true
else
  set_output links false
fi

if ((${#bun_packages[@]} == 0)); then
  bun_packages_json="[]"
else
  bun_packages_json="$(printf '%s\n' "${bun_packages[@]}" | jq -s -c '.')"
fi
set_output bun_packages "$bun_packages_json"
