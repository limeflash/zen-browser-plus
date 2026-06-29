#!/usr/bin/env bash
#
# Produce a SIGNED macOS arm64 MAR + the GitHub Pages update.xml for a Zen++ release.
#
# Prereqs (already done once, in this repo):
#   - surfer.json: github.repo = limeflash/zen-browser-plus, updateHostname = limeflash.github.io/zen-browser-plus
#   - engine updater embeds our MAR cert (toolkit/mozapps/update/updater/release_{primary,secondary}.der)
#   - mar-signing/nssdb holds the PRIVATE signing key (nickname: zenplus-release)  <-- keep secret
#
# Run AFTER `npm run build` + `npm run package` (those create dist/output.mar).
#
# Output (in dist/update-release/):
#   macos.mar                              -> upload to the GitHub release tagged <displayVersion>
#   pages/updates/browser/Darwin_aarch64-gcc3/release/update.xml  -> publish to GitHub Pages
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OBJ="$ROOT/engine/obj-aarch64-apple-darwin"
DIST="$OBJ/dist"
SIGNMAR="$DIST/bin/signmar"
export DYLD_LIBRARY_PATH="$DIST/bin"

NSSDB="$ROOT/mar-signing/nssdb"
CERT="zenplus-release"
CERT_DER="$ROOT/mar-signing/release_primary.der"
REPO="limeflash/zen-browser-plus"
PAGES_BASE="https://limeflash.github.io/zen-browser-plus"
CHANNEL="release"
TARGET="Darwin_aarch64-gcc3"           # macOS arm64 == Services.appinfo.OS + "_" + ABI

UNSIGNED="$ROOT/dist/output.mar"        # created by `npm run package` (surfer DIST_DIR = repo-root dist/)
APP="$DIST/Zen++.app"
OUT="$ROOT/dist/update-release"

[ -f "$UNSIGNED" ]   || { echo "ERROR: $UNSIGNED not found. Run 'npm run package' first."; exit 1; }
[ -d "$NSSDB" ]      || { echo "ERROR: signing key $NSSDB not found."; exit 1; }
[ -d "$APP" ]        || { echo "ERROR: $APP not found."; exit 1; }

# Version + buildID come from the freshly built app (must be > the installed one for the update to apply).
APPVERSION=$(sed -n 's/^Version=//p'       "$APP/Contents/Resources/application.ini" | head -1)
BUILDID=$(sed    -n 's/^BuildID=//p'       "$APP/Contents/Resources/application.ini" | head -1)
FFVERSION=$(python3 -c "import json;print(json.load(open('$ROOT/surfer.json'))['version']['version'])")
DISPLAYVERSION=$(python3 -c "import json;print(json.load(open('$ROOT/surfer.json'))['brands']['release']['release']['displayVersion'])")

mkdir -p "$OUT"
echo ">> Signing MAR with our key ($CERT)…"
"$SIGNMAR" -d "$NSSDB" -n "$CERT" -s "$UNSIGNED" "$OUT/macos.mar"
echo ">> Verifying signature against our embedded cert…"
"$SIGNMAR" -D "$CERT_DER" -v "$OUT/macos.mar"   # exit!=0 aborts via set -e

SIZE=$(wc -c < "$OUT/macos.mar" | tr -d ' ')
SHA512=$(shasum -a 512 "$OUT/macos.mar" | cut -d' ' -f1)
MARURL="https://github.com/$REPO/releases/download/$DISPLAYVERSION/macos.mar"

XMLDIR="$OUT/pages/updates/browser/$TARGET/$CHANNEL"
mkdir -p "$XMLDIR"
cat > "$XMLDIR/update.xml" <<EOF
<?xml version="1.0"?>
<updates>
  <update type="minor" displayVersion="$DISPLAYVERSION" appVersion="$APPVERSION" platformVersion="$FFVERSION" buildID="$BUILDID" detailsURL="https://github.com/$REPO/releases/tag/$DISPLAYVERSION">
    <patch type="complete" URL="$MARURL" hashFunction="sha512" hashValue="$SHA512" size="$SIZE"/>
  </update>
</updates>
EOF

cat <<EOF

=== Done ===
Signed MAR : $OUT/macos.mar   ($SIZE bytes, appVersion=$APPVERSION, buildID=$BUILDID)
update.xml : $XMLDIR/update.xml
MAR URL    : $MARURL

Publish:
  1) Create GitHub release tagged "$DISPLAYVERSION" on $REPO and upload macos.mar (+ the .dmg).
  2) Copy $OUT/pages/updates/  ->  the gh-pages branch root, commit & push.
     Final URL the browser checks:
       $PAGES_BASE/updates/browser/$TARGET/$CHANNEL/update.xml
  Note: appVersion ($APPVERSION) must be GREATER than the installed build for the update to apply.
EOF
