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

workflow_output="$(run_detector workflow push "" ".github/workflows/ci.yml")"
assert_output "$workflow_output" lint_workflows true
assert_output "$workflow_output" android false
assert_output "$workflow_output" ios false
assert_output "$workflow_output" links false
assert_bun_names "$workflow_output"

bridge_output="$(run_detector bridge push "" "agnt-bridge/src/bridge/bridge.js")"
assert_output "$bridge_output" lint_workflows false
assert_output "$bridge_output" android false
assert_output "$bridge_output" ios false
assert_output "$bridge_output" links false
assert_bun_names "$bridge_output" agnt-bridge

secure_output="$(run_detector secure push "" "agnt-web/src/crypto/transcript.ts")"
assert_output "$secure_output" android true
assert_output "$secure_output" ios true
assert_output "$secure_output" links false
assert_bun_names "$secure_output" agnt-bridge agnt-web

bun_action_output="$(run_detector bun_action push "" ".github/actions/setup-bun-package/action.yml")"
assert_output "$bun_action_output" lint_workflows true
assert_output "$bun_action_output" android false
assert_output "$bun_action_output" ios false
assert_output "$bun_action_output" links false
assert_bun_names "$bun_action_output" agnt-bridge relay agnt-web agnt-host

manual_bun_output="$(run_detector manual_bun workflow_dispatch bun "")"
assert_output "$manual_bun_output" lint_workflows false
assert_output "$manual_bun_output" android false
assert_output "$manual_bun_output" ios false
assert_output "$manual_bun_output" links false
assert_bun_names "$manual_bun_output" agnt-bridge relay agnt-web agnt-host

docs_output="$(run_detector docs push "" "README.md")"
assert_output "$docs_output" lint_workflows false
assert_output "$docs_output" android false
assert_output "$docs_output" ios false
assert_output "$docs_output" links true
assert_bun_names "$docs_output"

schedule_output="$(run_detector schedule schedule "" "")"
assert_output "$schedule_output" lint_workflows false
assert_output "$schedule_output" android false
assert_output "$schedule_output" ios false
assert_output "$schedule_output" links true
assert_bun_names "$schedule_output"

echo "CI change detector tests passed."
