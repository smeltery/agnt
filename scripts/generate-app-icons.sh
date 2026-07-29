#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_ICON="$ROOT_DIR/assets/agnt-app-icon.png"
WEB_PUBLIC_DIR="$ROOT_DIR/agnt-web/public"
ANDROID_ICON="$ROOT_DIR/AgntAndroid/app/src/main/res/drawable-nodpi/agnt_icon.png"
IOS_APP_LOGO="$ROOT_DIR/AgntMobile/AgntMobile/Assets.xcassets/AppLogo.imageset/Agnt-iOS-Default-1024x1024@1x.png"
IOS_CLASSIC_PREVIEW="$ROOT_DIR/AgntMobile/AgntMobile/Assets.xcassets/AppIconClassicPreview.imageset/agnt-icon-classic.png"

if [[ ! -f "$SOURCE_ICON" ]]; then
  echo "Missing source icon: $SOURCE_ICON" >&2
  exit 1
fi

if ! command -v sips >/dev/null 2>&1; then
  echo "This icon generator requires macOS sips." >&2
  exit 1
fi

generate_png() {
  local size="$1"
  local output="$2"
  sips -z "$size" "$size" "$SOURCE_ICON" --out "$output" >/dev/null
}

generate_png 32 "$WEB_PUBLIC_DIR/favicon-32.png"
generate_png 180 "$WEB_PUBLIC_DIR/apple-touch-icon.png"
generate_png 192 "$WEB_PUBLIC_DIR/icon-192.png"
generate_png 512 "$WEB_PUBLIC_DIR/icon-512.png"
generate_png 512 "$ANDROID_ICON"
generate_png 1024 "$IOS_APP_LOGO"
generate_png 256 "$IOS_CLASSIC_PREVIEW"

echo "Generated app icons from $SOURCE_ICON"
