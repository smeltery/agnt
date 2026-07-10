#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
detector="$script_dir/detect-ci-changes.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

run_detector() {
  local name="$1"
  local event_name="$2"
  local scope="$3"
  local changed_files="$4"
  local output_file="$tmp_dir/${name}.output"
  local summary_file="$tmp_dir/${name}.summary"

  GITHUB_EVENT_NAME="$event_name" \
    INPUT_SCOPE="$scope" \
    CHANGED_FILES_OVERRIDE="$changed_files" \
    GITHUB_OUTPUT="$output_file" \
    GITHUB_STEP_SUMMARY="$summary_file" \
    "$detector"

  printf '%s\n' "$output_file"
}

get_output() {
  local output_file="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "$output_file" | tail -n 1
}

assert_output() {
  local output_file="$1"
  local key="$2"
  local expected="$3"
  local actual

  actual="$(get_output "$output_file" "$key")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'Expected %s=%s, got %s\n' "$key" "$expected" "$actual" >&2
    printf 'Outputs from %s:\n' "$output_file" >&2
    cat "$output_file" >&2
    exit 1
  fi
}

assert_case() {
  local name="$1"
  local event_name="$2"
  local scope="$3"
  local changed_files="$4"
  local expected_lint_workflows="$5"
  local expected_android="$6"
  local expected_ios="$7"
  local expected_links="$8"
  local expected_bridge="${9}"
  local expected_relay="${10}"
  local expected_web="${11}"
  local expected_host="${12}"
  local output_file

  output_file="$(run_detector "$name" "$event_name" "$scope" "$changed_files")"
  assert_output "$output_file" lint_workflows "$expected_lint_workflows"
  assert_output "$output_file" android "$expected_android"
  assert_output "$output_file" ios "$expected_ios"
  assert_output "$output_file" links "$expected_links"
  assert_output "$output_file" bridge "$expected_bridge"
  assert_output "$output_file" relay "$expected_relay"
  assert_output "$output_file" web "$expected_web"
  assert_output "$output_file" host "$expected_host"
}

cases=(
  "workflow|push||.github/workflows/ci.yml|true|false|false|false|false|false|false|false"
  "bridge|push||agnt-bridge/src/bridge/bridge.js|false|false|false|false|true|false|false|false"
  "bridge_docs|push||agnt-bridge/README.md|false|false|false|true|false|false|false|false"
  "secure|push||agnt-web/src/crypto/transcript.ts|false|true|true|false|true|false|true|false"
  "flox_config|push||.flox/env/manifest.toml|false|true|false|false|true|true|true|true"
  "flox_action|push||.github/actions/setup-flox/action.yml|true|true|false|false|true|true|true|true"
  "bun_action|push||.github/actions/run-bun-package-ci/action.yml|true|false|false|false|true|true|true|true"
  "android_action|push||.github/actions/run-android-ci/action.yml|true|true|false|false|false|false|false|false"
  "ios_action|push||.github/actions/build-unsigned-ios-ipa/action.yml|true|false|true|false|false|false|false|false"
  "link_action|push||.github/actions/run-link-check/action.yml|true|false|false|true|false|false|false|false"
  "web_docs|push||agnt-web/README.md|false|false|false|true|false|false|false|false"
  "host_docs|push||agnt-host/README.md|false|false|false|true|false|false|false|false"
  "relay_docs|push||relay/README.md|false|false|false|true|false|false|false|false"
  "manual_packages|workflow_dispatch|packages||false|false|false|false|true|true|true|true"
  "manual_host|workflow_dispatch|host||false|false|false|false|false|false|false|true"
  "docs|push||README.md|false|false|false|true|false|false|false|false"
  "schedule|schedule|||false|false|false|true|false|false|false|false"
)

for case_spec in "${cases[@]}"; do
  IFS="|" read -r name event_name scope changed_files lint_workflows android ios links bridge relay web host <<< "$case_spec"
  assert_case "$name" "$event_name" "$scope" "$changed_files" "$lint_workflows" "$android" "$ios" "$links" "$bridge" "$relay" "$web" "$host"
done

echo "CI change detector tests passed."
