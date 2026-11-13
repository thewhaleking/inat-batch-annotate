# iNat Batch Annotate (Safari extension)

Add the same annotation (Alive or Dead, Life Stage, Sex, Evidence of Presence,
Flowers and Fruits, Leaves) to many iNaturalist observations at once.

## Install

1. Download `iNat-Batch-Annotate-<version>.zip` from the
   [latest release](https://github.com/thewhaleking/inat-batch-annotate/releases/latest) and unzip it.
2. Move `iNat Batch Annotate.app` to `/Applications` and open it once.
3. In Safari: Settings > Extensions > turn on "iNat Batch Annotate".
   Allow it on inaturalist.org.

Needs macOS 12 or later.

## Use

1. Sign in on www.inaturalist.org. Go to an observations search page and filter it
   (for example your observations of one taxon).
2. Click the toolbar button. The side panel opens.
3. Click "Use this page's filters" (or type iNat API search parameters, e.g.
   `user_id=you&taxon_id=47170&without_term_id=1`), then Load.
4. Select observations: click cards (shift-click for a range), or use the taxon-group chips.
5. Pick a value for each annotation to add. Each card shows a preview:
   green "+" = will add, grey "–" = skip (already set, or not valid for that taxon).
6. Click Apply. Requests go at about 1 per second (iNat's API rate guidance). Stop at any time.

Tip: `without_term_id=<attribute id>` loads only observations that lack that annotation
(1 Life Stage, 9 Sex, 17 Alive or Dead, 22 Evidence of Presence, 12 Flowers and Fruits, 36 Leaves).

## How it works

- `extension/content.js` reads the session JWT from the page's
  `<meta name="inaturalist-api-token">` tag (or `/users/api_token`) and calls
  `api.inaturalist.org/v1`: `GET /observations`, `GET /controlled_terms`, `POST /annotations`.
- Which annotations fit which taxa uses the same rules as the iNat web app
  (`termsForTaxon` in `app/webpack/observations/show/ducks/controlled_terms.js`,
  plus the multivalued / blocking rules in `components/annotations.jsx`).
  The server validates every annotation again.
- Edit files in `extension/`, then rebuild. The Xcode project references them directly.
- `tools/make_icons.py` regenerates the icons.

## Build from source

`./build.sh` builds an ad-hoc signed app into `build/`. To use it, turn on
Safari > Settings > Developer > "Allow unsigned extensions" (Safari turns this
off each time it quits). Or open `iNat Batch Annotate/iNat Batch Annotate.xcodeproj`
in Xcode, set your own team for both targets, and press Run.

## Release (maintainer)

1. One time: create a "Developer ID Application" certificate (Xcode > Settings >
   Accounts > Manage Certificates), then save notarization credentials:
   `xcrun notarytool store-credentials inat-notary --apple-id <apple id> --team-id WNN7X2QWF4`
2. Increase `version` in `extension/manifest.json` and commit.
3. `./release.sh --publish` archives, signs with Developer ID, notarizes, staples,
   zips, tags `v<version>`, and creates the GitHub release.
   Without `--publish` it only makes `build/release/iNat-Batch-Annotate-<version>.zip`.

## License

MIT
