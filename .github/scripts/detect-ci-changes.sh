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
  [[ "$manual_scope" == "packages" && "$surface" =~ ^(bridge|relay|web|host)$ ]]
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
setup_flox_action='^\.github/actions/setup-flox/'
bun_ci_action='^\.github/actions/run-bun-package-ci/'
android_ci_action='^\.github/actions/run-android-ci/'
ios_ipa_action='^\.github/actions/build-unsigned-ios-ipa/'
flox_config='^\.flox/'
flox_common="$flox_config|$setup_flox_action"
bun_common="$flox_common|$bun_ci_action"
secure_bridge='^agnt-bridge/src/(transport/)?secure-transport\.js'
secure_web='^agnt-web/src/crypto/'
secure_ios='^(AgntMobile/AgntMobile/Core/Networking/CodexSecureTransportModels\.swift|AgntMobile/AgntMobile/Services/CodexService/Transport/CodexService\+SecureTransport\.swift)'
secure_android='^(AgntAndroid/app/src/main/kotlin/com/dotbrains/agnt/mobile/core/model/SecureTransportModels\.kt|AgntAndroid/app/src/main/kotlin/com/dotbrains/agnt/mobile/core/crypto/)'
# These files implement one shared encrypted transport contract across clients.
# Any change fans out to every parity surface that can compile-test it.
secure_transport="$secure_bridge|$secure_web|$secure_ios|$secure_android"
android_code='^(AgntAndroid/(app|gradle)/|AgntAndroid/(build\.gradle\.kts|settings\.gradle\.kts|gradle\.properties|gradlew|gradlew\.bat))'
bridge_code='^agnt-bridge/(bin/|scripts/|src/|test/|package\.json|bun\.lock)'
relay_code='^relay/([^/]+\.js|[^/]+\.test\.js|package\.json|bun\.lock)'
web_code='^agnt-web/(src/|test/|public/|index\.html|package\.json|bun\.lock|tsconfig\.json|vite\.config\.ts|\.size-limit\.json)'
host_code='^agnt-host/(src/|scripts/|public/|index\.html|pet\.html|popup\.html|copy-bundled\.mjs|package\.json|tsconfig[^/]*\.json|vite\.config\.ts|eslint\.config\.js)'

platform_surfaces=(android ios)

surface_pattern() {
  case "$1" in
    bridge) printf '%s\n' "$bun_common|$secure_transport|$bridge_code" ;;
    relay) printf '%s\n' "$bun_common|$relay_code" ;;
    web) printf '%s\n' "$bun_common|$secure_transport|$web_code" ;;
    host) printf '%s\n' "$bun_common|$host_code" ;;
    android) printf '%s\n' "$android_ci_action|$flox_common|$secure_transport|$android_code" ;;
    ios) printf '%s\n' "$ios_ipa_action|$secure_transport|^AgntMobile/" ;;
    links) printf '%s\n' "$link_check_action|^.*\.md$|^\.lycheeignore$" ;;
    *) echo "Unknown CI surface: $1" >&2; return 1 ;;
  esac
}

surface_enabled() {
  local surface="$1"
  should_run "$surface" "$(surface_pattern "$surface")"
}

if matches "$ci_config"; then set_output lint_workflows true; else set_output lint_workflows false; fi

for surface in "${platform_surfaces[@]}"; do
  if surface_enabled "$surface"; then set_output "$surface" true; else set_output "$surface" false; fi
done

if [[ "$event_name" == "schedule" ]] || surface_enabled links; then
  set_output links true
else
  set_output links false
fi

for surface in bridge relay web host; do
  if surface_enabled "$surface"; then set_output "$surface" true; else set_output "$surface" false; fi
done
