#!/usr/bin/env bash
# Production: current universal build -> signed app -> notarized/stapled app -> signed/notarized/stapled DMG.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT/app"
TARGET=universal-apple-darwin
TEAM_ID="${APPLE_TEAM_ID:-2X3MVMZTR2}"
NOTARY_PROFILE="${NOTARY_PROFILE:-haki-notary}"
OUT_DIR="${HAKI_RELEASE_OUT_DIR:-$ROOT/output/release}"
SKIP_BUILD=0; TEST_ONLY=0; ADHOC=0
for arg in "$@"; do
 case "$arg" in --skip-build) SKIP_BUILD=1;; --skip-notarize) TEST_ONLY=1;; --adhoc) TEST_ONLY=1;ADHOC=1;; *) echo "Unknown argument: $arg" >&2;exit 2;; esac
done
VERSION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$APP_DIR/src-tauri/tauri.conf.json")"
mkdir -p "$OUT_DIR"
if [[ $ADHOC -eq 1 ]];then IDENTITY=-;else
 IDENTITY="${APPLE_SIGNING_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' | head -1)}"
 [[ "$IDENTITY" == *"($TEAM_ID)" ]] || { echo 'Expected Haki Developer ID identity unavailable' >&2;exit 1; }
fi
NOTARY_ARGS=(--keychain-profile "$NOTARY_PROFILE")
if [[ $TEST_ONLY -eq 0 ]];then xcrun notarytool history "${NOTARY_ARGS[@]}" --output-format json > "$OUT_DIR/notary-history-before.json";fi
if [[ $SKIP_BUILD -eq 0 ]];then
 for arch in aarch64-apple-darwin x86_64-apple-darwin;do rustup target list --installed | grep -qx "$arch" || rustup target add "$arch";done
 (cd "$APP_DIR"; [[ -d node_modules ]] || npm ci; env -u APPLE_SIGNING_IDENTITY -u APPLE_ID -u APPLE_PASSWORD -u APPLE_API_KEY -u APPLE_API_KEY_PATH npx tauri build --target "$TARGET" --bundles app)
fi
APP="$APP_DIR/src-tauri/target/$TARGET/release/bundle/macos/Haki.app"
[[ -d "$APP" ]]
lipo -info "$APP/Contents/MacOS/Haki" | tee "$OUT_DIR/architectures.txt"
grep -q arm64 "$OUT_DIR/architectures.txt";grep -q x86_64 "$OUT_DIR/architectures.txt"
while IFS= read -r -d '' item;do codesign --force --options runtime --timestamp --sign "$IDENTITY" "$item";done < <(find "$APP/Contents" -depth \( -name '*.dylib' -o -name '*.so' -o -name '*.framework' \) -print0)
codesign --force --options runtime --timestamp --entitlements "$APP_DIR/src-tauri/Entitlements.plist" --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
if [[ $TEST_ONLY -eq 0 ]];then
 ditto -c -k --keepParent "$APP" "$OUT_DIR/notary-app.zip"
 xcrun notarytool submit "$OUT_DIR/notary-app.zip" "${NOTARY_ARGS[@]}" --wait --timeout 30m --output-format json > "$OUT_DIR/notary-app.json"
 python3 -c 'import json,sys;assert json.load(open(sys.argv[1]))["status"]=="Accepted"' "$OUT_DIR/notary-app.json"
 xcrun stapler staple "$APP";xcrun stapler validate "$APP"
fi
STAGE="$(mktemp -d "$OUT_DIR/dmg-stage.XXXXXX")"
trap '[[ ! -d "$STAGE" ]] || rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/Haki.app";ln -s /Applications "$STAGE/Applications"
DMG="$OUT_DIR/Haki_${VERSION}_universal.dmg"
[[ ! -e "$DMG" ]] || { echo 'Refusing to overwrite an existing release artifact' >&2;exit 1; }
hdiutil create -volname Haki -srcfolder "$STAGE" -format UDZO -fs HFS+ "$DMG" > "$OUT_DIR/dmg-build.log"
codesign --force --timestamp --sign "$IDENTITY" "$DMG"
if [[ $TEST_ONLY -eq 0 ]];then
 xcrun notarytool submit "$DMG" "${NOTARY_ARGS[@]}" --wait --timeout 30m --output-format json > "$OUT_DIR/notary-dmg.json"
 python3 -c 'import json,sys;assert json.load(open(sys.argv[1]))["status"]=="Accepted"' "$OUT_DIR/notary-dmg.json"
 xcrun stapler staple "$DMG";xcrun stapler validate "$DMG"
 codesign --verify --deep --strict --verbose=2 "$APP"
 spctl --assess --type execute --verbose=2 "$APP" > "$OUT_DIR/gatekeeper-app.txt" 2>&1
 spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG" > "$OUT_DIR/gatekeeper-dmg.txt" 2>&1
 grep -q 'accepted' "$OUT_DIR/gatekeeper-app.txt";grep -q 'Notarized Developer ID' "$OUT_DIR/gatekeeper-app.txt"
fi
rm -rf "$STAGE";trap - EXIT
# Archive only the final stapled app, and hash final stapled distribution bytes.
ditto -c -k --keepParent "$APP" "$OUT_DIR/Haki_${VERSION}_universal.app.zip"
(cd "$OUT_DIR";shasum -a 256 "Haki_${VERSION}_universal.dmg" "Haki_${VERSION}_universal.app.zip" > "SHA256SUMS-${VERSION}.txt")
if [[ $TEST_ONLY -eq 1 ]];then echo 'TEST BUILD ONLY — not approved for distribution';else echo "VERIFIED DISTRIBUTION: $DMG";fi
