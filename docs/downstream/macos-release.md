# macOS Release Contract

RepoBud v1 is a directly distributed, Apple-silicon macOS application. A
locally packaged app is a preview artifact; it is not a release until the signing, notarization,
distribution, and minimum-OS gates below pass.

The primary-source rationale is retained in
[macOS release and client support research](../research/macos-release-and-client-support-contracts.md).

## Local preview package

The supported local path is:

```bash
npm run package:macos
npm run verify:macos-package
npm run preview -- /path/to/repository
```

The package command produces
`../VSCode-darwin-arm64/RepoBud.app`, sets the declared macOS floor, removes
unused camera, microphone, audio-capture, and Apple Events privacy declarations, applies an ad-hoc
signature for local integrity, and verifies:

- Workbench name, bundle identifier, icon, version, commit, and arm64 architecture;
- macOS 13 minimum;
- no Visual Studio Code or Code - OSS product identity;
- no Microsoft webview CDN and no enabled update feed;
- a deep, strict code-signature envelope.

The ad-hoc signature has no publisher identity or notarization ticket. It must never be presented
as a production release.

## Supported versions

Release notes must use **required**, **validated**, and **unverified** precisely. Compatibility
outside an exact validated fixture is not implied.

| Surface | First-release contract |
| --- | --- |
| macOS | Require macOS 13 or later on Apple silicon. Validate the release on macOS 13 and the current supported macOS release. |
| Git | Require Git 2.35 or later for the complete retained Git UI. The baseline is validated with Apple Git 2.39.5. |
| Codex | Skill projection is validated with Codex CLI 0.145.0. Other versions are unverified. The disabled inherited agent host is not a product feature. |
| Claude Code | Skill and MCP projection are validated with Claude Code 2.1.220. Other versions are unverified. |
| Cursor | File projection is validated with Cursor desktop 3.13.10, build `4f02290ccd9304f0e6bf8ee85f6e9106f02ac1f7`. Other builds are unverified. Cursor Agent CLI is not a runtime dependency. |
| Agent Skills | Pin specification fixture commit `38a2ff82958afee88dadf4831509e6f7e9d8ef4e`. |
| MCP | Pin protocol revision `2025-06-18`. |

The adapter fixtures under
`src/vs/workbench/contrib/repoBud/test/fixtures/` are authoritative release evidence.
Client versions and format revisions must be updated independently.

## Production publisher prerequisites

The release owner must provide and approve:

- a final legally owned product name, icon, bundle identifier, URL scheme, copyright, download
  origin, and product-owned DMG background;
- Apple Developer Program membership, Team ID, and a `Developer ID Application` certificate with
  protected private-key custody;
- a Keychain-backed `notarytool` profile or App Store Connect API credentials supplied by CI,
  never committed to the repository;
- final least-privilege entitlements for every nested executable and privacy-purpose strings for
  any permission the focused product actually uses;
- retention of `LICENSE.txt`, `ThirdPartyNotices.txt`, and all component notices;
- a publisher-controlled HTTPS artifact host and, only when updates are enabled, a separately
  controlled update feed with rollback, staged rollout, retention, monitoring, and credential
  rotation owners.

The preview identity `dev.htjun.repobud` is not evidence that the final identifier is
registered or owned.

## Signing, notarization, and distribution gate

Production builds must use hardened runtime, a secure timestamp, and the audited per-process
entitlements. Sign nested code before the outer app; do not use `--deep` as a substitute for the
correct signing order. Submit the signed container with `notarytool`, inspect and retain the notary
log, staple the app and DMG, and recreate the ZIP only after the contained app is stapled.

Run these checks against the exact bytes to be published:

```bash
codesign --verify --deep --strict --verbose=2 "RepoBud.app"
codesign --display --entitlements :- "RepoBud.app"
xcrun stapler validate "RepoBud.app"
xcrun stapler validate "RepoBud.dmg"
spctl --assess --type execute --verbose=2 "RepoBud.app"
```

On macOS 14 or later, also run `syspolicy_check distribution`. The final manual gate is a
quarantined, offline-capable installation from the published DMG on macOS 13. It must exercise
repository selection, Keychain access, Git review, and update/no-update behavior.

## Update boundary

`product.json` intentionally omits `quality` and `updateUrl`, so updates remain disabled. Do not set
an update URL until a signed and notarized N-to-N+1 ZIP round trip passes against the exact retained
Code OSS update response contract. Never use Microsoft's update service or CDN.

Every update must preserve the final bundle identifier and signing authority. Notarization,
code-signing, artifact publishing, and update-feed credentials must be isolated from each other.

## Release evidence

The packaged E2E harness creates an isolated repository, configuration repository, application
profile, home directory, extension directory, shared-data directory, in-memory mock Keychain, and
mock remote services. The application process receives only a minimal host environment, so it
cannot read the developer's real global client configuration, Keychain, or credentials. It covers
repository switching, Git review, Skills, client projections, MCP, Connections, and Plugins.

On failure, the harness deletes the raw fixture tree and retains only a cleared screenshot,
accessibility snapshot, application/console logs, selected runtime logs, and a manifest under
`test-results/repobud-shell/`. Exact fixture tokens, authorization headers,
credential-bearing URLs, temporary paths, and common secret fields are redacted.

The upstream upgrade rehearsal accepts only an exact semantic version whose local
`refs/tags/<version>` commit matches the tag advertised by the official
`https://github.com/microsoft/vscode.git` remote. A local branch or locally invented tag with the
same version shape is rejected.

A production release record must include the exact macOS, Git, client, protocol, schema, Electron,
Code OSS tag, downstream commit, Team ID, notarization submission ID, checksums, upgrade-rehearsal
report, and packaged E2E result.
