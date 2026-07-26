# Plugin package and lifecycle contracts

Research snapshot: 2026-07-26

Scope: current first-party documentation, specifications, source code, and
release metadata for Codex, Claude Code, and Cursor plugins. This note covers
the contracts needed to import a local directory or pinned Git source into the
Repository Context Workbench. It does not treat community tools or observed
client behavior as a stable contract.

## Decision summary

- There is no portable plugin-package standard shared by Codex, Claude Code,
  and Cursor. Use a Workbench-owned `PluginPackage` model and versioned import
  adapters. Do not make any native client manifest canonical.
- Import an exact immutable snapshot. For Git, record the requested ref and
  the resolved commit separately. For a local directory, copy the exact
  observed files and record whether the directory was inside a dirty Git
  worktree.
- Record the manifest version and license as publisher claims. Neither is an
  integrity identifier. Compute a Workbench-owned SHA-256 content hash over
  every imported package file.
- Inventory instructions and executable authority separately. Hooks, monitors,
  workflow scripts, local MCP/LSP commands, and referenced scripts require an
  explicit trust grant bound to the exact content hash before activation or
  projection.
- Treat remote MCP servers and declared variables as connection requirements,
  not credentials. Installing a package must not create, select, or delete a
  Connection.
- Detect updates into a separate immutable candidate. Never mutate the active
  package until the user chooses Apply, Merge, or Fork.
- Model the last imported snapshot, the user's current working snapshot, and
  the incoming snapshot independently. This is the minimum state needed for a
  real three-way merge and for reliable local-change detection.
- Keep Disable, Deactivate, Disconnect, and Uninstall as different domain
  actions. None should be implemented as an alias for another.
- Project package-owned Skills and MCP definitions through the existing
  Workbench adapters. Do not delegate lifecycle ownership to native plugin
  managers, because their trust, update, and conflict behavior differs.

## There is no shared plugin format

The three products overlap in vocabulary but not in package contracts.

| Surface | Package entry point | Documented component families | Source and lifecycle characteristics |
| --- | --- | --- | --- |
| Codex / ChatGPT | Required `.codex-plugin/plugin.json` | Skills, hooks, bundled MCP servers, registered MCP mappings, and presentation assets | Local, Git root/subdirectory, and npm marketplace sources are documented. Git entries may declare `ref` or `sha`. Plugins are copied to a versioned Codex cache and have a separate enabled state. |
| Claude Code | Optional `.claude-plugin/plugin.json`; default folders can be discovered without it | Skills/commands, agents, hooks, MCP, LSP, workflows, output styles, themes, monitors, channels, and dependencies | Local, GitHub, arbitrary Git, Git subdirectory, npm, and marketplace-relative sources are documented. Marketplace installs are copied to a versioned cache. Some marketplaces can update installed files automatically. |
| Cursor | Required `.cursor-plugin/plugin.json` with only `name` required | Rules, skills, agents, commands, hooks, MCP servers, scripts, and canvases | Local development plugins load from `~/.cursor/plugins/local`; marketplace plugins are Git repositories. Public marketplace submissions and updates are reviewed by Cursor. |

Codex documents `.codex-plugin/plugin.json`, `skills/`, `hooks/`, `.mcp.json`,
and `.app.json`, and its marketplace format supports local paths, Git roots,
Git subdirectories, and npm packages. Git-backed entries can use `ref` or
`sha`; npm packages are downloaded without running npm lifecycle scripts.
Sources:

- [OpenAI: Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [Codex plugin manifest parser, pinned source](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core-plugins/src/manifest.rs)
- [Codex marketplace parser, pinned source](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core-plugins/src/marketplace.rs)

Claude Code's manifest has materially more component types and its field merge
rules vary by component. For example, custom `skills` paths normally add to
default discovery, while several other custom paths replace it; hooks, MCP,
and LSP have their own merge rules. A shared filename does not imply shared
semantics. Sources:

- [Claude Code: Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code: Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)

Cursor requires a different manifest root and supports its own automatic
component discovery. Its `variables` field declares names and schemas for
configuration values; actual values are set separately, and secret values
must not be committed to the plugin. Sources:

- [Cursor: Plugins](https://cursor.com/docs/plugins.md)
- [Cursor: Plugins reference](https://cursor.com/docs/reference/plugins.md)
- [Cursor's pinned plugin template](https://github.com/cursor/plugin-template/tree/46216072ac5750f782f95bb325b4d12b7c3ae9c9)

### Import adapter rule

An importer should detect all recognized manifests, then require an explicit
choice if more than one is present and they disagree. It may use a compatible
manifest as a metadata fallback, but it must retain:

- the selected ecosystem and manifest path;
- the unmodified raw manifest;
- warnings and unknown fields;
- the resolved component inventory produced by that ecosystem's rules; and
- compatibility results for every target client.

Do not merge native manifests field-by-field into a synthetic manifest. That
would erase meaningful differences such as Claude's additive skill paths and
Cursor's replacement behavior.

## Source provenance

The first release should support exactly two source kinds: a local directory
and a Git source resolved to a commit. Marketplace and npm support can be added
later as source resolvers without changing the package model.

### Local directory

At preview time:

1. Resolve and record the absolute source path.
2. Copy a read-only snapshot into an app-owned staging directory.
3. Exclude VCS administration data such as `.git/`, but include all package
   content, including dotfiles and manifests.
4. Reject path traversal, devices, sockets, FIFOs, and symlinks that resolve
   outside the package root.
5. If the source is inside a Git worktree, record the repository remote, HEAD
   object ID, relative path, and dirty/untracked status as observations only.

A dirty local directory is not equivalent to its HEAD commit. Its authoritative
revision is the Workbench content hash, while Git observations help the user
understand provenance.

The absolute local locator is machine state, not portable configuration. Keep
it in the disposable machine registry. The portable package record needs only
`kind: localDirectory`, a user-facing source label, the imported content hash,
and any non-secret Git observation the user explicitly chooses to retain.

### Pinned Git source

Store both intent and resolution:

```text
remote URL
requested ref or revision
resolved commit object ID
repository subdirectory, if any
detected Git object format
fetch timestamp
```

A branch and a tag can move. The installed snapshot must always use the
resolved commit, even when the user supplied a friendly ref. The friendly ref
can remain the update channel. A raw commit without a tracked ref has no
automatic "latest" candidate; the user must select a different revision.

Claude Code explicitly distinguishes `ref` from a full commit `sha`, and its
version fallback uses the source commit when no manifest version is present.
Codex likewise accepts Git `ref` or `sha` selectors. These contracts justify
recording both fields, but the Workbench should not inherit either client's
version precedence. Sources:

- [Claude Code: GitHub and Git source pins](https://code.claude.com/docs/en/plugin-marketplaces#github-repositories)
- [Claude Code: Version resolution](https://code.claude.com/docs/en/plugin-marketplaces#version-resolution-and-release-channels)
- [OpenAI: Git-backed plugin sources](https://developers.openai.com/plugins/build/plugins)

Fetch into an app-owned bare cache with terminal prompts disabled, resolve the
commit, and materialize the selected tree without executing repository hooks
or package-manager lifecycle scripts. Do not recursively initialize
submodules in v1. Report a submodule entry as unsupported rather than silently
producing an incomplete package. Reject credential-bearing remote URLs and use
the user's existing Git credential mechanism.

## Metadata is not integrity

All three ecosystems expose a `version` and `license`-like manifest field.
Claude documents semantic versioning and an SPDX license identifier. Cursor
describes semantic version and license identifier fields. Codex publishes
version and license metadata on its install surfaces. These fields are useful
publisher claims, not proof of the bytes installed.

The Workbench should record:

```ts
interface PluginMetadata {
	readonly name: string;
	readonly displayName?: string;
	readonly version?: string;
	readonly license?: {
		readonly declared: string;
		readonly spdxStatus: 'valid' | 'invalid' | 'unknown';
	};
	readonly author?: ReadonlyArray<{
		readonly name: string;
		readonly url?: string;
	}>;
	readonly homepage?: string;
	readonly repository?: string;
}
```

Never use a manifest version as an update or equality key. Claude Code
explicitly warns that a stale manifest version can mask new commits because
its cache considers that version unchanged. This is a useful compatibility
fact, not behavior the Workbench should copy.

Source: [Claude Code version management](https://code.claude.com/docs/en/plugins-reference#version-management).

## Deterministic content hash

No reviewed client contract exposes a cross-client content digest suitable for
this product's integrity and merge requirements. Define one:

```text
contentHash = "sha256:" + SHA256(canonical package inventory)
```

For each non-VCS entry, hash a length-delimited record containing:

1. normalized UTF-8 relative path with `/` separators;
2. entry kind (`file` or safe relative symlink);
3. executable bit for files;
4. byte length and raw file bytes, or the normalized symlink target; and
5. no timestamps, ownership, absolute paths, or platform-specific metadata.

Sort records by bytewise normalized path before hashing. Reject duplicate
normalized paths, case-fold collisions on the target macOS filesystem, unsafe
symlinks, and unsupported entry kinds. Include unknown files: an unrecognized
script is still part of the authority being installed.

Keep three independent hashes:

- `baseHash`: last upstream snapshot accepted by the user;
- `workingHash`: current canonical package content; and
- `incomingHash`: fetched update candidate.

This state distinguishes clean updates, local changes, and divergence without
depending on Git availability or publisher version hygiene.

## Installation preview

The preview must be an inventory of authority, not just a manifest summary.
Show at least:

| Group | Required preview details |
| --- | --- |
| Package | Source, requested revision, resolved revision, subdirectory, manifest kind, name, version, license, content hash |
| Instructions | Skills, rules, agents, commands, workflows, and prompt-affecting files |
| Executable content | Hooks and events, monitors, executable workflows, referenced scripts, local MCP commands, local LSP commands, shell preprocessors, and executable-bit files |
| Network/tool authority | Remote MCP endpoints, local MCP tool servers, HTTP hooks, and channel declarations |
| Connections | Required provider or server, declared variable names, sensitivity, required/optional status, and whether a compatible Connection already exists |
| Compatibility | Supported clients, client-only components, ignored fields, conflicts, validation warnings, and unsupported paths |
| Change impact | New, removed, or changed capabilities compared with the installed snapshot |

### Component inventory differences

Codex packages Skills, MCP mappings/servers, hooks, and assets. It separately
states that installing or enabling a plugin does not automatically trust its
hooks; non-managed hooks are skipped until the current definition is trusted.
Source: [OpenAI plugin hook trust](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks).

Claude plugins can execute command hooks, start MCP and LSP processes, and run
unsandboxed background monitors. Claude explicitly describes plugins and
marketplaces as highly trusted components that can execute arbitrary code with
the user's privileges. Sources:

- [Claude Code plugin security](https://code.claude.com/docs/en/discover-plugins#security)
- [Claude Code hook and MCP components](https://code.claude.com/docs/en/plugins-reference#plugin-components-reference)

Cursor packages scripts and hooks as well as instructions and MCP definitions.
Its marketplace security page says plugins ship no binaries, but still
describes supporting scripts and recommends source review. It also states that
public marketplace plugins and every update are manually reviewed. That review
is useful provenance, but it is not a substitute for a local trust decision,
especially for a local or pinned-Git source outside the public marketplace.
Sources:

- [Cursor plugin structure](https://cursor.com/docs/reference/plugins.md#plugin-structure)
- [Cursor marketplace security](https://cursor.com/help/security-and-privacy/marketplace-security.md)

### Trust contract

Use two visible risk classes:

- `instructionAuthority`: content that changes model behavior or tool choice;
- `executableAuthority`: content that can start a process, run a hook, call an
  MCP tool, or send a network request without the user manually running it.

Installation may store an untrusted package, but activation and projection of
executable authority must fail closed until the user grants:

```ts
interface PluginTrustGrant {
	readonly pluginPackageId: string;
	readonly contentHash: string;
	readonly executableEntryPoints: ReadonlyArray<{
		readonly kind: string;
		readonly path?: string;
		readonly commandSummary?: string;
	}>;
	readonly grantedAt: string;
}
```

Trust is for an exact content hash, not for a path, branch, author name, or
marketplace label. Every applied update requires user approval. If executable
entry points or their referenced files changed, the previous executable trust
grant becomes stale and requires a new explicit grant. If only instruction
content changed, executable trust may remain valid, but the update still
requires an explicit Apply or Merge action.

Do not execute validation supplied by the package during preview. Built-in
parsers may read manifests and text, but package scripts and package-manager
install hooks remain inert.

## Connection requirements are declarations

Connection requirements vary by ecosystem:

- Codex can map a plugin to a previously registered MCP connection in
  `.app.json`; marketplace policy can request authentication on install or on
  use. Its app-server install response can list apps needing authentication,
  but the current official source marks these APIs under development.
- Claude can declare MCP servers, channels, and typed `userConfig`, including
  sensitive fields stored separately from the plugin.
- Cursor can declare a JSON Schema for variable names and substitute those
  values into MCP configuration; the plugin repository must not contain the
  values.

Sources:

- [OpenAI registered MCP mappings](https://developers.openai.com/plugins/build/plugins#create-and-test-a-plugin-locally-with-an-mcp-server)
- [Pinned Codex app-server plugin lifecycle](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/README.md#plugins)
- [Claude Code user configuration](https://code.claude.com/docs/en/plugins-reference#user-configuration)
- [Cursor plugin variables](https://cursor.com/docs/reference/plugins.md#variables)

Normalize these to non-secret requirements:

```ts
interface PluginConnectionRequirement {
	readonly id: string;
	readonly providerId?: string;
	readonly integrationId?: string;
	readonly serverId?: string;
	readonly required: boolean;
	readonly fields: ReadonlyArray<{
		readonly name: string;
		readonly sensitive: boolean;
		readonly description?: string;
	}>;
}
```

The package must not contain a `connectionRef` selected for a particular user.
After installation, the repository or global Integration selection binds a
compatible Connection. Missing authentication is `Needs attention`, not an
installation failure unless the user explicitly chose "connect during
install."

## Workbench-owned update semantics

Native lifecycle behavior is not suitable as the canonical implementation:

- Claude Code can update installed plugin files in the background; official
  Anthropic marketplaces enable that behavior by default.
- Cursor documents repository refresh and marketplace review, but its official
  docs do not define a local three-way merge or preservation contract for
  edited installed content.
- Codex exposes marketplace upgrade and plugin install/uninstall operations,
  but current app-server plugin operations are marked under development and do
  not define local merge or fork semantics.

Sources:

- [Claude Code automatic plugin updates](https://code.claude.com/docs/en/discover-plugins#automatic-updates)
- [Cursor update review and team marketplace refresh](https://cursor.com/docs/plugins.md#keep-plugins-up-to-date)
- [Pinned Codex app-server methods](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/README.md#message-schema)

The Workbench should fetch only metadata and an immutable incoming snapshot
during update detection. It must not modify the canonical package directory,
client projections, activation, trust, or Connections.

### Update state

```ts
type PluginUpdateState =
	| 'current'
	| 'updateAvailable'
	| 'locallyModified'
	| 'diverged'
	| 'mergeConflicted'
	| 'sourceUnavailable';
```

Resolution is mechanical:

- `workingHash === baseHash` and `incomingHash !== baseHash`:
  `updateAvailable`.
- `workingHash !== baseHash` and `incomingHash === baseHash`:
  `locallyModified`.
- all three differ: `diverged`.
- the source cannot be resolved: `sourceUnavailable`; retain the last good
  snapshot.

### Apply, Merge, and Fork

All three actions begin from an update preview and require confirmation.

- **Apply** accepts the incoming snapshot as the new base and working content.
  With local changes, this is explicitly destructive. Preserve a recoverable
  internal snapshot and exportable patch before replacement; do not create a
  Git commit automatically.
- **Merge** performs a three-way merge with `base`, `working`, and `incoming`.
  Text files can be merged automatically. Binary changes and unresolved text
  conflicts remain blocked. Because the product is a viewer, open the
  canonical package in an external editor for conflict resolution, then
  revalidate and rehash before activation.
- **Fork** copies the working snapshot to a new local-source package with a new
  stable package ID, detaches it from the upstream update channel, and retains
  an `originalSource` provenance link. The original package remains unchanged
  until the user separately applies its update. This is a local product fork,
  not an implicit GitHub API operation.

Never patch an ecosystem's cache directory in place. The Workbench's
user-owned configuration repository remains canonical, while native client
locations are projections that can be recreated.

## Distinct lifecycle actions

| Action | Package files | Plugin enablement | Capability activation | Connection secret |
| --- | --- | --- | --- | --- |
| Disable plugin | Retained | Off | Derived capabilities unavailable | Retained |
| Deactivate capability | Retained | On | One Skill/Integration off at global or repository scope | Retained |
| Disconnect | Retained | Unchanged | Remains installed but may need attention | Deleted only for the chosen Connection |
| Uninstall | Removed after impact review | Removed | Plugin-owned activation/projections removed | Shared Connections retained |

Uninstall must show dependents and local modifications. It should remove
package-owned projections and definitions, but never delete a Connection just
because the package once required it. Forgetting a Connection is a separate
explicit action.

Claude Code itself distinguishes disable from uninstall and can preserve
plugin data during uninstall. Cursor exposes separate plugin, MCP, rule, and
skill management. Codex stores plugin enablement separately from the cached
package and exposes a distinct uninstall operation. These client contracts
support, but do not fully define, the Workbench distinction.

Sources:

- [Claude Code installed plugin management](https://code.claude.com/docs/en/discover-plugins#manage-installed-plugins)
- [Cursor installed plugin management](https://cursor.com/docs/plugins.md#managing-installed-plugins)
- [Pinned Codex plugin store](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core-plugins/src/store.rs)

## Recommended domain model

Keep an immutable package snapshot separate from mutable installation state:

```ts
interface PluginPackage {
	readonly id: string;
	readonly source: PluginSource;
	readonly metadata: PluginMetadata;
	readonly manifest: {
		readonly ecosystem: 'codex' | 'claudeCode' | 'cursor' | 'none';
		readonly path?: string;
		readonly raw: unknown;
	};
	readonly contentHash: string;
	readonly components: PluginComponentInventory;
	readonly connectionRequirements: ReadonlyArray<PluginConnectionRequirement>;
	readonly importedAt: string;
}

type PluginSource =
	| {
		readonly kind: 'localDirectory';
		readonly sourceLabel: string;
		readonly machineLocatorRef: string;
		readonly gitObservation?: {
			readonly remote?: string;
			readonly head?: string;
			readonly subdirectory?: string;
			readonly dirty: boolean;
		};
	}
	| {
		readonly kind: 'git';
		readonly remote?: string;
		readonly sourceLabel?: string;
		readonly machineLocatorRef?: string;
		readonly requestedRevision: string;
		readonly resolvedRevision: string;
		readonly subdirectory?: string;
		readonly trackedRef?: string;
	};

interface PluginInstallation {
	readonly pluginPackageId: string;
	readonly enabled: boolean;
	readonly baseHash: string;
	readonly workingHash: string;
	readonly trust?: PluginTrustGrant;
	readonly updateCandidate?: {
		readonly packageId: string;
		readonly detectedAt: string;
	};
}
```

`PluginComponentInventory` should preserve native fields but normalize at least:

- Skills and other instruction components;
- MCP server definitions and registered endpoint mappings;
- executable entry points and referenced files;
- Connection requirements;
- client compatibility and validation findings; and
- ownership links to the canonical `SkillDefinition`,
  `McpServerDefinition`, and `IntegrationDefinition` records created on
  installation.

Use random opaque package IDs. Do not derive identity from a mutable name,
version, source URL, or content hash. A content-identical package from a
different source can then retain distinct provenance and update channels.

## Required implementation fixtures

1. Import a clean local directory, a dirty local Git directory, a Git root,
   and a Git subdirectory pinned to a resolved commit.
2. Reject traversal, case-fold collisions, escaping symlinks, credential URLs,
   device files, and Git submodules.
3. Parse representative Codex, Claude Code, and Cursor packages, including
   default discovery and custom component paths.
4. Preview Skills, instruction files, local and remote MCP definitions, hooks,
   scripts, monitors/LSP commands, and required sensitive/non-sensitive
   configuration names without exposing values.
5. Prove that preview and validation run no package executable, npm lifecycle
   script, Git hook, MCP process, or network endpoint.
6. Prove deterministic hashes across temporary directories and mtimes, and
   changed hashes for byte, safe-symlink-target, path, or executable-bit
   changes.
7. Store an untrusted executable package but block enablement and projection;
   trust it; then prove an executable update invalidates the grant.
8. Detect an update without changing canonical files, client projections,
   activation, Connections, or trust.
9. Exercise clean Apply, destructive Apply with recovery, clean three-way
   Merge, conflicted Merge, binary conflict, and local Fork.
10. Verify Disable, Deactivate, Disconnect, and Uninstall affect only the rows
    in the lifecycle table above.
11. Scan the canonical repository, internal state, projections, logs, errors,
    and update artifacts for fixture secrets.
12. Pin compatibility fixtures to the exact client releases below and rerun
    them on every client upgrade.

## Release fixture pins

| Surface | Pin | Reason |
| --- | --- | --- |
| Codex source contract | commit `61a44880a85d2fd0d8770908dea5733495e571c8` (2026-07-26) | Exact source behind the current manifest, marketplace, store, and app-server claims. |
| Codex release | `0.145.0` (2026-07-21) | Current stable release fixture already used by the MCP research. |
| Claude Code | `@anthropic-ai/claude-code@2.1.220` (2026-07-24) | Current package on the research date and supports the documented current plugin fields. |
| Cursor macOS arm64 | `3.13.10`, commit `4f02290ccd9304f0e6bf8ee85f6e9106f02ac1f7` | Exact stable artifact returned by Cursor's official download API on the research date. |
| Cursor plugin template | commit `46216072ac5750f782f95bb325b4d12b7c3ae9c9` | Exact first-party package fixture rather than a mutable template branch. |

Sources:

- [Codex 0.145.0 release](https://github.com/openai/codex/releases/tag/rust-v0.145.0)
- [Claude Code npm package metadata](https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/2.1.220)
- [Cursor stable download metadata](https://cursor.com/api/download?platform=darwin-arm64&releaseTrack=stable)
- [Cursor pinned plugin template](https://github.com/cursor/plugin-template/tree/46216072ac5750f782f95bb325b4d12b7c3ae9c9)

## Explicit uncertainties

- OpenAI's plugin documentation spans Codex, ChatGPT desktop, and a universal
  directory. Current app-server plugin install/uninstall methods are explicitly
  under development. Treat the pinned source as a fixture, not a stable public
  integration API.
- Codex documentation describes hook trust, but it does not publish a portable
  package-wide trust or content-hash format.
- Claude Code's automatic update and cache version contracts do not preserve
  edited installed content or define a three-way merge workflow.
- Cursor's official docs do not define installed-versus-latest version
  inspection, user pinning, content hashes, or local-edit conflict semantics.
- Cursor's public marketplace review applies to its curated marketplace. The
  official docs do not extend that guarantee to arbitrary local or pinned-Git
  sources.
- No reviewed client specifies a cross-client meaning for "Fork." The local
  detached-source behavior in this note is a Workbench domain decision.
- Client manifests change quickly. Preserve raw manifests and unknown fields,
  keep adapters versioned, and rerun pinned fixtures before changing any
  projection claim.
