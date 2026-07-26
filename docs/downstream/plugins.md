# Plugin packages and lifecycle

RepoBud treats a Plugin as a secondary installable capability bundle. A
Plugin may own Skills, MCP Integration definitions, executable scripts, and non-secret Connection
requirements. Installation does not activate a repository capability or connect an account.

There is no common package format across Codex, Claude Code, and Cursor. The first release therefore
uses a Workbench-owned manifest and projects owned capabilities through the existing client
adapters. The primary-source comparison and pinned client fixtures are recorded in
`docs/research/plugin-package-lifecycle-contracts.md`.

## Package manifest

A package root contains `repobud-plugin.json`:

```json
{
	"schemaVersion": 1,
	"id": "review-tools",
	"name": "Review Tools",
	"version": "1.0.0",
	"license": "MIT",
	"skills": ["skills/review"],
	"integrations": ["integrations/issues.json"],
	"scripts": ["scripts/check.sh"],
	"connections": [{ "provider": "github" }]
}
```

Every path is relative to the package root. Traversal, symbolic links, special files, undeclared
executable files, duplicate requirements, credential-bearing Git URLs, and unsupported manifest
fields are rejected. Preview reads files with built-in parsers only; it never runs package scripts,
Git hooks, MCP processes, or package-manager lifecycle commands.

## Installation and provenance

The Plugin Library accepts:

- a local directory, copied as an immutable snapshot; or
- a Git source and requested revision, resolved to an exact detached commit before inspection.

The preview shows source, requested and resolved revision, package version, license, SHA-256 content
hash, Skills, MCP definitions, scripts, and Connection requirements. The installation record stores
those portable facts with the package in the user-owned configuration repository. Absolute paths
for both local directories and local Git repositories are held only in the machine profile behind
opaque locator references.

The content hash covers every package file, normalized relative path, bytes, and executable mode.
It excludes Git administration data and Workbench installation metadata. Version and license are
publisher claims; only the content hash identifies exact bytes.

## Trust

Instruction content is visible in the preview. Any declared or executable-bit file is executable
authority. Trust is bound to the exact working content hash, not a source path, Git branch, author,
or Plugin name.

An executable package may be installed without trust, but it remains disabled. Enabling it requires
an explicit trust grant. Any local change invalidates that grant. An executable update requires a
new grant before the updated package can remain enabled. RepoBud does not
execute Plugin scripts itself.

## Updates

Checking for updates materializes a separate candidate and never changes package files, activation,
Connections, projections, or trust. The service keeps three snapshots:

- base: the last accepted upstream package;
- working: the current canonical package in the configuration repository; and
- incoming: the inspected update candidate.

The update preview lists added, modified, and deleted files. The user then chooses:

- **Apply** — replace working content with incoming content.
- **Merge** — perform a deterministic three-way file merge; divergent files remain blocked and no
  partial result is installed.
- **Fork local version** — copy working content to a new disabled local package with detached
  provenance, leaving the original package unchanged.

No update is applied automatically and no Git commit or push is created.

## Distinct lifecycle actions

| Action | Package files | Plugin enablement | Capability activation | Connection secret |
| --- | --- | --- | --- | --- |
| Disable Plugin | Retained | Off | Owned capabilities unavailable | Retained |
| Deactivate Skill or Integration | Retained | On | Off at global or repository scope | Retained |
| Disconnect | Retained | Unchanged | May need attention | Deleted only for that Connection |
| Uninstall Plugin | Removed after confirmation | Removed | Owned definitions disappear | Retained |

Plugin Library and Plugin Updates are secondary actions in the Skills and Integrations title menus;
Plugins are not a fourth primary product area.
