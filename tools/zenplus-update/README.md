# Zen++ auto-update (from our GitHub)

Zen++ is built to check for and install updates from **our** infrastructure instead of
`updates.zen-browser.app`. Two pieces are baked into the binary; the rest is publishing.

## How it works

```
 Zen++.app  ──GET──►  https://limeflash.github.io/zen-browser-plus/updates/browser/Darwin_aarch64-gcc3/release/update.xml
                          │  (static file on GitHub Pages — the "AUS" response)
                          ▼
                      <patch URL="https://github.com/limeflash/zen-browser-plus/releases/download/<ver>/macos.mar" ...>
                          │
                          ▼
 download macos.mar ──► verify signature against OUR embedded cert ──► apply update
```

Baked into the build (already configured in this repo):
- `surfer.json` → `updateHostname = limeflash.github.io/zen-browser-plus` (the update-check host)
  and `brands.release.release.github.repo = limeflash/zen-browser-plus` (where MARs live).
- `engine/toolkit/mozapps/update/updater/release_primary.der` + `release_secondary.der` = **our**
  public MAR cert (also kept in `src/toolkit/mozapps/update/updater/` so re-imports preserve it).
  `MOZ_VERIFY_MAR_SIGNATURE=1` stays on — only MARs signed by our key are accepted.

`%BUILD_TARGET%` on macOS arm64 = `Darwin_aarch64-gcc3`; `%CHANNEL%` = `release`.

## One-time setup

1. **Signing key** — `mar-signing/` (gitignored) holds the NSS DB with the private key
   (nickname `zenplus-release`, RSA-4096/SHA-384) and the exported `release_primary.der`.
   **Back this directory up somewhere safe.** If you lose it you can never ship an update that
   existing installs will accept (you'd have to rebuild+redistribute with a new embedded cert).
   For CI signing, store it as a secret (e.g. base64 of a tarball of `mar-signing/nssdb`).

2. **GitHub Pages** — enable Pages on `limeflash/zen-browser-plus`, serving from a `gh-pages`
   branch (root). The browser only ever GETs a static `update.xml`, so Pages is enough.

## Cutting a release

```bash
# 1. Build + package (bumps/sets the version via surfer.json displayVersion).
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/python@3.11/libexec/bin:$PATH"
export SURFER_PLATFORM=darwin SURFER_COMPAT=aarch64
npm run build && npm run package        # -> dist/zen-<ver>.en-US.mac.dmg + dist/output.mar (unsigned)

# 2. Sign the MAR + generate the Pages update.xml.
tools/zenplus-update/make-update.sh      # -> dist/update-release/{macos.mar, pages/updates/...}
```

Then publish:
- Create a GitHub **release** tagged exactly the `displayVersion` (e.g. `1.21.4b`) on
  `limeflash/zen-browser-plus`; upload `dist/update-release/macos.mar` (and the `.dmg`).
- Copy `dist/update-release/pages/updates/` to the **gh-pages** branch root and push.

The update only triggers when the published `appVersion` is **greater** than the installed
build's version, so bump `surfer.json` `brands.release.release.displayVersion` each release.

## Verifying a MAR by hand

```bash
DIST=engine/obj-aarch64-apple-darwin/dist
DYLD_LIBRARY_PATH=$DIST/bin $DIST/bin/signmar -D mar-signing/release_primary.der -v dist/update-release/macos.mar
# exit 0 = signature valid (this is exactly the check the embedded updater performs)
```

## Rotating / regenerating the key

```bash
DIST=engine/obj-aarch64-apple-darwin/dist; export DYLD_LIBRARY_PATH=$DIST/bin
certutil -d mar-signing/nssdb -N --empty-password
certutil -S -d mar-signing/nssdb --empty-password -z mar-signing/noise.bin \
  -s "CN=ZenPlus MAR signing key" -n zenplus-release -x -t ",,u" -g 4096 -Z SHA384 -m 1 -v 120
certutil -L -d mar-signing/nssdb --empty-password -n zenplus-release -r > mar-signing/release_primary.der
cp mar-signing/release_primary.der mar-signing/release_secondary.der
cp mar-signing/release_*.der engine/toolkit/mozapps/update/updater/
cp mar-signing/release_*.der src/toolkit/mozapps/update/updater/
# then rebuild so the new public cert is embedded
```

> Caveat: an unsigned/ad-hoc `.app` can self-update, but macOS Gatekeeper still applies to the
> result. For a clean install-and-update experience on other Macs, codesign+notarize the build
> (out of scope here).
