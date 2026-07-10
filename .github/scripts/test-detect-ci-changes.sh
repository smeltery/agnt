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

assert_bun_names() {
  local output_file="$1"
  shift
  local expected_json
  local actual_json

  if (($# == 0)); then
    expected_json="[]"
  else
    expected_json="$(printf '%s\n' "$@" | jq -R -s -c 'split("\n")[:-1]')"
  fi
  actual_json="$(get_output "$output_file" bun_packages | jq -c '[.[].name]')"
  if [[ "$actual_json" != "$expected_json" ]]; then
    printf 'Expected bun packages %s, got %s\n' "$expected_json" "$actual_json" >&2
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
  local expected_bun_names="$9"
  local output_file
  local -a bun_names=()

  output_file="$(run_detector "$name" "$event_name" "$scope" "$changed_files")"
  assert_output "$output_file" lint_workflows "$expected_lint_workflows"
  assert_output "$output_file" android "$expected_android"
  assert_output "$output_file" ios "$expected_ios"
  assert_output "$output_file" links "$expected_links"

  if [[ -n "$expected_bun_names" ]]; then
    read -r -a bun_names <<< "$expected_bun_names"
    assert_bun_names "$output_file" "${bun_names[@]}"
  else
    assert_bun_names "$output_file"
  fi
}

cases=(
  "workflow|push||.github/workflows/ci.yml|true|true|true|true|agnt-bridge relay agnt-web agnt-host"
  "bridge|push||agnt-bridge/src/bridge/bridge.js|false|false|false|false|agnt-bridge"
  "secure|push||agnt-web/src/crypto/transcript.ts|false|true|true|false|agnt-bridge agnt-web"
  "bun_action|push||.github/actions/run-bun-package-ci/action.yml|true|false|false|false|agnt-bridge relay agnt-web agnt-host"
  "flox_config|push||.flox/env/manifest.toml|false|true|false|false|agnt-bridge relay agnt-web agnt-host"
  "flox_action|push||.github/actions/setup-flox/action.yml|true|true|false|false|agnt-bridge relay agnt-web agnt-host"
  "android_action|push||.github/actions/run-android-ci/action.yml|true|true|false|false|"
  "ios_action|push||.github/actions/build-unsigned-ios-ipa/action.yml|true|false|true|false|"
  "link_action|push||.github/actions/run-link-check/action.yml|true|false|false|true|"
  "manual_packages|workflow_dispatch|packages||false|false|false|false|agnt-bridge relay agnt-web agnt-host"
  "manual_bun|workflow_dispatch|bun||false|false|false|false|agnt-bridge relay agnt-web agnt-host"
  "docs|push||README.md|false|false|false|true|"
  "schedule|schedule|||false|false|false|true|"
)

for case_spec in "${cases[@]}"; do
  IFS="|" read -r name event_name scope changed_files lint_workflows android ios links bun_names <<< "$case_spec"
  assert_case "$name" "$event_name" "$scope" "$changed_files" "$lint_workflows" "$android" "$ios" "$links" "$bun_names"
done

echo "CI change detector tests passed."
