# RepoBud

RepoBud is a focused desktop companion for working across Git repositories with AI development
tools. One repository is active at a time, keeping its Source Control state, Skills, Integrations,
Connections, and Plugins in one context-first workspace.

RepoBud is a viewer and control surface rather than a code editor. It retains the Code OSS Git
review experience, including staged and unstaged changes, diffs, commit history, branches, remotes,
and common repository operations.

## Current Scope

- Select, clone, initialize, and switch the active repository.
- Review diffs and manage staged and unstaged changes.
- Use the retained Git graph and Source Control operations.
- Manage global and repository-specific Skills with visible provenance.
- Project Skills and MCP configuration to Codex, Claude Code, and Cursor.
- Manage Connections and trusted Plugin packages.
- Open files and diffs in a read-only viewer.

The initial package target is macOS 13 or later on Apple silicon.

## Local Development

Use the Node.js version pinned in `.nvmrc`, install dependencies, and launch RepoBud directly from
source:

```bash
nvm use
npm install
npm run dev
```

The development command performs a fast source build, prepares the pinned Electron runtime and
built-in extensions, opens the RepoBud checkout, and keeps its application state in
`~/.repobud-dev`. Pass another repository with `npm run dev -- /path/to/repository`. Rerun the
command after source changes. Set `REPOBUD_DEV_DATA_DIR` to use a different development profile
location.

## Packaged Preview

Use the Node.js version pinned in `.nvmrc`, install dependencies, and package the application:

```bash
nvm use
npm install
npm run package:macos
npm run preview -- /path/to/repository
```

The verified application is written to:

```text
../VSCode-darwin-arm64/RepoBud.app
```

See the [downstream baseline](docs/downstream/baseline.md), [naming
contract](docs/downstream/naming.md), and [macOS release
contract](docs/downstream/macos-release.md) for the complete build and distribution requirements.

## Upstream Foundation

RepoBud is a downstream distribution of the
[Code - OSS repository](https://github.com/microsoft/vscode). The upstream source is retained under
the MIT License. See [LICENSE.txt](LICENSE.txt), [ThirdPartyNotices.txt](ThirdPartyNotices.txt), and
the pinned [downstream baseline](docs/downstream/baseline.md) for attribution and provenance.
