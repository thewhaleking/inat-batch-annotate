#!/bin/zsh
# Build the Safari extension app (ad-hoc signed) into ./build.
set -e
cd "$(dirname "$0")"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -project "iNat Batch Annotate/iNat Batch Annotate.xcodeproj" \
  -scheme "iNat Batch Annotate" -configuration Release -derivedDataPath build \
  CODE_SIGN_IDENTITY="-" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="" build | grep -E "error|BUILD"
echo "App: $PWD/build/Build/Products/Release/iNat Batch Annotate.app"
