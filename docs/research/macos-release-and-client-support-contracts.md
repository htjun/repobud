# macOS Release and Client Support Contracts

Snapshot: 2026-07-26. This note uses Apple, Electron, Microsoft, Git,
OpenAI, Anthropic, Cursor, Agent Skills, and MCP primary sources only.

## Release decision

Repository Context Workbench should ship first as a directly distributed,
Apple-silicon macOS application. The first public release should require
macOS 13 or later, even though the current Electron 42 bundle can start on
macOS 12. This gives the product one stated floor that also satisfies Claude
Code's documented macOS 13 minimum
([Claude Code system requirements](https://code.claude.com/docs/en/setup#system-requirements)).
Electron documents macOS 12 as the runtime floor from v38 through v43
([Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes)).
Encode the product decision in
`LSMinimumSystemVersion`; Apple defines that key as the minimum macOS version
required to run an app ([Apple `LSMinimumSystemVersion`](https://developer.apple.com/documentation/bundleresources/information-property-list/lsminimumsystemversion)).

Do not call a local package a release merely because it launches. The current
`VSCode-darwin-arm64/Repository Context Workbench.app` is arm64 and declares
`LSMinimumSystemVersion=12.0`, but its top-level signature is ad-hoc, has no
Team ID, fails strict resource verification, and has no stapled notarization
ticket. It is a preview artifact.

## What can and cannot be completed locally

### External publisher credentials and decisions

These are release prerequisites, not repository-generated artifacts:

- Apple Developer Program membership and a final legal publisher/team. Apple
  issues Developer ID certificates only to program members
  ([Developer ID certificate](https://developer.apple.com/help/glossary/developer-id-certificate/)).
- A `Developer ID Application` certificate and its private key. This signs an
  app distributed outside the Mac App Store; a separate `Developer ID
  Installer` certificate is needed only if the product later ships a signed
  installer package. Apple restricts certificate creation to the Account
  Holder, with limited cloud-managed access for authorized admins
  ([Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)).
- Notary-service authentication: either an App Store Connect API key or an
  Apple ID app-specific password, Team ID, and a Keychain profile. Apple
  documents `notarytool store-credentials` so CI does not place a password in
  a script
  ([custom notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)).
- A final publisher-owned bundle identifier, update origin, download origin,
  signing-key custody policy, and recovery/rotation owner. Register an explicit
  App ID if a provisioning profile or managed Apple capability is introduced
  ([register an App ID](https://developer.apple.com/help/account/identifiers/register-an-app-id/)).
- Product-name and icon clearance. The Code OSS MIT license does not grant the
  right to identify this fork as Visual Studio Code. Microsoft explicitly
  prohibits using the Visual Studio Code name or icon to identify another
  product ([Microsoft brand guidelines](https://code.visualstudio.com/brand)).

### Implementable local hardening

The repository can and should provide all of the following without holding a
production secret:

- final `product.json` identity, icon, URL scheme, copyright, license links,
  bundle identifier, version, build commit, architecture, and explicit minimum
  macOS version;
- deterministic arm64 app, ZIP, and DMG build jobs, plus checksums and a
  machine-readable release manifest;
- hardened-runtime signing automation with per-process entitlements and no
  embedded identity, password, API key, or private key;
- notarization and stapling automation that receives a Keychain profile or CI
  secret reference;
- strict signature, entitlement, Gatekeeper, notarization-ticket, architecture,
  minimum-OS, and clean-profile smoke gates;
- an update client that remains disabled until a publisher-owned feed and
  signed production artifact exist;
- release notes with explicit tested client and format pins.

## Signing, hardened runtime, notarization, and stapling

Apple's current direct-distribution contract requires all executable code to
be signed with an appropriate Developer ID identity, hardened runtime enabled,
a secure timestamp, no true `com.apple.security.get-task-allow`, and valid XML
entitlements. The notary service scans the submitted software and its
code-signing state
([notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)).

The retained signing implementation in
[`build/darwin/sign.ts`](../../build/darwin/sign.ts) already asks
`@electron/osx-sign` for hardened runtime and selects separate app/helper
entitlement files. Before release:

1. Replace every inherited Visual Studio Code privacy-purpose string with
   Workbench-specific copy and remove permissions the focused viewer does not
   use.
2. Audit every entitlement on every nested executable. In particular,
   `allow-jit`, `allow-unsigned-executable-memory`, and
   `disable-library-validation` are hardened-runtime exceptions, not harmless
   metadata. Apple states that writable executable memory is disallowed by
   default because it creates a security risk
   ([allow-JIT entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-jit)).
3. Sign nested frameworks, helpers, native modules, and executables before the
   outer app, then sign the final app with a timestamp. Do not use `--deep` as
   a substitute for a correct signing order; Apple recommends `--deep` for
   recursive verification, not normal signing
   ([TN2206](https://developer.apple.com/library/archive/technotes/tn2206/)).
4. Submit the signed app container with `xcrun notarytool submit ... --wait`,
   save and inspect the notary log even after success, then staple the app and
   final DMG. A ZIP can be notarized but cannot itself be stapled; staple its
   contents before recreating it
   ([custom notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)).
5. Validate the exact bytes to be published:

   ```bash
   codesign --verify --deep --strict --verbose=2 "Repository Context Workbench.app"
   codesign --display --entitlements :- "Repository Context Workbench.app"
   xcrun stapler validate "Repository Context Workbench.app"
   xcrun stapler validate "Repository Context Workbench.dmg"
   spctl --assess --type execute --verbose=2 "Repository Context Workbench.app"
   ```

   Apple documents the strict `codesign` and `spctl` checks as Gatekeeper
   conformance checks
   ([TN2206](https://developer.apple.com/library/archive/technotes/tn2206/)).

The final manual gate is a quarantined download on the minimum supported macOS
version: mount the published DMG, drag the app to `/Applications`, launch it,
exercise Keychain access, repository selection, Git operations, and update
discovery. Apple notes that Gatekeeper behavior must be tested on quarantined
distribution media, not only on the build-directory app
([TN2206](https://developer.apple.com/library/archive/technotes/tn2206/)).

## Distribution and update feed

The current [`product.json`](../../product.json) has no `quality` or
`updateUrl`, so the inherited update service remains disabled. Keep it that way
until the following exist:

- a publisher-controlled HTTPS feed and artifact host;
- stable release/channel/version/commit/architecture identifiers;
- a signed and notarized arm64 ZIP for every feed entry;
- rollback and staged-rollout policy, retention, monitoring, and an incident
  owner;
- publishing credentials isolated from notarization and code-signing
  credentials.

Electron's macOS updater is Squirrel.Mac. It requires a signed application and
expects JSON metadata whose update URL resolves to a ZIP archive; a server
returns `204 No Content` when no update exists
([Electron `autoUpdater`](https://www.electronjs.org/docs/latest/api/auto-updater/),
[Electron update server contract](https://www.electronjs.org/docs/latest/tutorial/updates)).
Repository Context Workbench retains Code OSS's more specific
`<updateUrl>/api/update/<asset>/<quality>/<commit>` request shape in
[`abstractUpdateService.ts`](../../src/vs/platform/update/electron-main/abstractUpdateService.ts)
and
[`updateService.darwin.ts`](../../src/vs/platform/update/electron-main/updateService.darwin.ts).
The service owner must fixture-test that exact downstream response contract
before setting `updateUrl`.

An update must preserve the final bundle identifier and signing authority.
macOS code-signing policy uses a designated requirement to recognize valid
updates; Apple recommends inspecting it with `codesign -d -r-`
([TN2206](https://developer.apple.com/library/archive/technotes/tn2206/)).
Never point a fork at Microsoft's update service. Microsoft's own Code OSS
documentation says the Microsoft distribution adds a private update service
through `product.json`
([Code OSS versus Visual Studio Code](https://github.com/microsoft/vscode/wiki/Differences-between-the-repository-and-Visual-Studio-Code)).

## Branding and license gate

Code OSS is MIT-licensed source, while Visual Studio Code is Microsoft's
separately customized distribution
([microsoft/vscode](https://github.com/microsoft/vscode),
[Microsoft product license](https://code.visualstudio.com/license)).
The release must:

- retain `LICENSE.txt`, `ThirdPartyNotices.txt`, and all required component
  notices;
- use only the Workbench name, icon, bundle ID, URL scheme, privacy strings,
  help text, about text, DMG artwork, and download/update domains;
- contain no Microsoft telemetry, marketplace, update, authentication, or
  branding endpoint unless its use is separately authorized and documented.

Issues found by the research snapshot and routed into product hardening were:

- [`build/darwin/sign.ts`](../../build/darwin/sign.ts) inserts four privacy
  descriptions that still name Visual Studio Code;
- [`build/darwin/create-dmg.ts`](../../build/darwin/create-dmg.ts) uses
  `resources/darwin/code.icns` for the disk image instead of the product icon;
- [`product.json`](../../product.json) still contains a Microsoft CDN URL and
  mutable upstream license URLs.

The hardening implementation removes the unused privacy declarations, uses the product icon and
title in the DMG path, pins the source license URL, and removes the Microsoft webview CDN from the
focused product. A final product-owned DMG background, publisher-approved identity, and
Developer-ID release execution remain production prerequisites.

Direct Developer ID distribution without App Sandbox is the appropriate v1
channel. Apple requires App Sandbox for the Mac App Store, while the focused
Workbench needs user-selected repository access and local Git/client process
execution
([Apple macOS distribution](https://developer.apple.com/macos/distribution/)).
Record this as a conscious boundary, not as an omission: compensate with
explicit repository selection, least-privilege hardened-runtime entitlements,
and the isolated release tracers.

## Supported-version statement

Use three separate terms in release notes:

- **required**: the product refuses or cannot provide the advertised feature
  below this version;
- **validated**: exact version/commit used by release fixtures;
- **unverified**: may work, but has not passed the pinned fixture suite.

Do not turn mutable client documentation into a broad semver promise. Codex,
Claude Code, and Cursor do not publish one shared compatibility/versioning
contract for Skills, MCP projection, Plugins, or enablement state.

| Surface | First-release statement | Authoritative detection or format source |
| --- | --- | --- |
| Workbench | macOS 13+ on Apple silicon; validate on the floor and current release macOS | `LSMinimumSystemVersion`; Electron 42 itself can run on macOS 12+, while Electron 44 will require macOS 13 ([Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes)) |
| Git | Require Git 2.35+ for the complete retained UI; validated with Apple Git 2.39.5 on macOS 15.6.1 | The pinned Git extension exposes full retained actions behind `gitVersion2.35`; detect with `git --version`, the official Git version command ([Git version](https://git-scm.com/docs/git-version)) |
| Codex projection | Validated with Codex CLI `0.145.0`; other versions are unverified until the projection fixtures pass | Exact [OpenAI 0.145.0 release](https://github.com/openai/codex/releases/tag/rust-v0.145.0), version from `codex --version` as used by the [official installer](https://github.com/openai/codex/blob/main/scripts/install/install.sh), and versioned schemas from `codex app-server generate-json-schema` or `generate-ts` ([Codex App Server](https://developers.openai.com/codex/app-server/)) |
| Claude Code projection | Validated with `2.1.220`; other versions are unverified. Claude Code itself requires macOS 13+ | Exact [npm release artifact](https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/2.1.220); detect with `claude --version` ([Claude Code setup](https://code.claude.com/docs/en/setup)) |
| Cursor desktop projection | Validated with macOS arm64 `3.13.10`, build `4f02290ccd9304f0e6bf8ee85f6e9106f02ac1f7`; other builds are unverified | Exact [Cursor stable download metadata](https://cursor.com/api/download?platform=darwin-arm64&releaseTrack=stable); keep desktop build and Cursor Agent CLI version separate |
| Cursor Agent CLI | No runtime dependency for file projection; if later used for health checks, validate and record the exact CLI build independently | Detect with `cursor-agent --version` ([Cursor CLI installation](https://cursor.com/docs/cli/installation)) |

The Git minimum is a downstream product decision derived from the pinned
[`extensions/git`](../../extensions/git), not a claim that Git 2.35 is still
maintained upstream. The exact baseline environment is recorded in
[`docs/downstream/baseline.md`](../downstream/baseline.md).

Pin format revisions independently of client versions:

| Format | Release pin |
| --- | --- |
| Canonical Workbench configuration | repository schema version `1` |
| Workbench Plugin package | manifest version `1` |
| Agent Skills | exact specification fixture commit [`38a2ff82958afee88dadf4831509e6f7e9d8ef4e`](https://github.com/agentskills/agentskills/commit/38a2ff82958afee88dadf4831509e6f7e9d8ef4e), not only the mutable [Agent Skills specification](https://agentskills.io/specification) |
| MCP | protocol revision `2025-06-18` ([MCP specification](https://modelcontextprotocol.io/specification/2025-06-18)) |

The repository currently generates an inherited, disabled agent-host protocol
client from `@openai/codex 0.142.0`, while repository projection fixtures use
Codex `0.145.0`. Because `repositoryContextWorkbench.disableAgentHost` is true,
that protocol is not an advertised Workbench feature. Before release, either
exclude it from the shipped focused surface or align its pin and rerun
`npm run codex:check-protocol`; do not present the two different pins as one
support claim.

## Release gate

A release is ready only when all of these are true:

1. The final arm64 app declares the intended name, bundle ID, version, build,
   icon, URL scheme, and macOS 13 minimum.
2. All packaged Mach-O files have the expected architecture and valid nested
   Developer ID signatures with audited entitlements and hardened runtime.
3. The exact published app/ZIP/DMG is notarized; the app and DMG have valid
   stapled tickets; Gatekeeper accepts a quarantined installation.
4. Repository, Git review, Skill, client projection, MCP, Connection, Plugin,
   Keychain, and update/no-update tracers pass with isolated repositories,
   profiles, configuration homes, and Keychain namespaces.
5. Failure screenshots and logs are retained after credential, authorization
   header, token, environment, home path, repository path, and Keychain
   metadata redaction.
6. The exact macOS, Git, client, protocol, schema, Electron, Code OSS tag,
   downstream commit, signing Team ID, and notarization submission ID are
   recorded in immutable release evidence.
7. The feed remains disabled until a signed update round-trip from release N
   to N+1 passes on the minimum supported macOS version.

On macOS 14 or later, add Apple's current `syspolicy_check distribution`
assessment alongside `codesign`; retain `spctl` for older supported systems,
then perform the quarantined offline installation test
([Apple DTS distribution checklist](https://developer.apple.com/forums/thread/130560)).
