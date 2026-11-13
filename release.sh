#!/bin/zsh
# Build, sign (Developer ID), notarize and zip the app for a GitHub release.
#
# One-time setup:
#   1. Xcode > Settings > Accounts > (your team) > Manage Certificates > + > Developer ID Application
#   2. Save notarization credentials in the keychain (uses an app-specific password
#      from account.apple.com):
#        xcrun notarytool store-credentials inat-notary --apple-id <you> --team-id WNN7X2QWF4
#
# Usage:
#   ./release.sh            # build, notarize, zip into build/release/
#   ./release.sh --publish  # also tag v<version> and create the GitHub release
#
# The version comes from extension/manifest.json.
set -euo pipefail
cd "$(dirname "$0")"

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
NOTARY_PROFILE="${NOTARY_PROFILE:-inat-notary}"
TEAM_ID="WNN7X2QWF4"
APP_NAME="iNat Batch Annotate"
PROJECT="$APP_NAME/$APP_NAME.xcodeproj"
OUT="build/release"
VERSION=$(/usr/bin/python3 -c 'import json;print(json.load(open("extension/manifest.json"))["version"])')
ZIP="$OUT/iNat-Batch-Annotate-$VERSION.zip"

PUBLISH=0
[[ "${1:-}" == "--publish" ]] && PUBLISH=1

if (( PUBLISH )); then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Commit your changes first." >&2; exit 1
  fi
  if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
    echo "Tag v$VERSION exists. Bump the version in extension/manifest.json." >&2; exit 1
  fi
fi

echo "==> Version $VERSION"
rm -rf "$OUT"; mkdir -p "$OUT"

echo "==> Archive"
xcodebuild -project "$PROJECT" -scheme "$APP_NAME" -configuration Release \
  -destination "generic/platform=macOS" -archivePath "$OUT/app.xcarchive" \
  MARKETING_VERSION="$VERSION" -allowProvisioningUpdates archive -quiet

echo "==> Export (Developer ID)"
cat > "$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>developer-id</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
</dict></plist>
EOF
xcodebuild -exportArchive -archivePath "$OUT/app.xcarchive" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" \
  -allowProvisioningUpdates -quiet
APP="$OUT/export/$APP_NAME.app"

echo "==> Notarize"
ditto -c -k --keepParent "$APP" "$OUT/notarize.zip"
xcrun notarytool submit "$OUT/notarize.zip" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"

echo "==> Verify"
codesign --verify --deep --strict "$APP"
spctl --assess --type execute -vv "$APP"

echo "==> Zip"
ditto -c -k --keepParent "$APP" "$ZIP"
shasum -a 256 "$ZIP"

if (( PUBLISH )); then
  echo "==> GitHub release v$VERSION"
  git tag "v$VERSION"
  git push origin "v$VERSION"
  gh release create "v$VERSION" "$ZIP" --title "v$VERSION" --generate-notes
fi
echo "Done: $ZIP"
