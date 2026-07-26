# Code OSS Downstream Baseline

## Pinned source

| Field | Value |
| --- | --- |
| Upstream | `https://github.com/microsoft/vscode.git` |
| Git remote | `upstream` |
| Stable release | `1.130.0` |
| Upstream commit | `1b6a188127eeaf9194f945eb6eb89a657e93c54c` |
| Release published | 2026-07-22 |
| Source license | MIT; preserve `LICENSE.txt` and `ThirdPartyNotices.txt` |
| Initial platform | macOS on Apple silicon |

The tag is the latest non-draft, non-prerelease GitHub release available when the baseline was
selected on 2026-07-26. Treat the tag and commit as immutable inputs.

## Branch and remote policy

- `main` is the downstream integration line. It starts at the pinned upstream commit and carries
  documentation and product commits on top.
- `upstream` always points to `microsoft/vscode`. It is fetch-only and must never receive pushes.
- A future downstream hosting remote should be named `origin`.
- Evaluate an upgrade on `codex/upstream-<version>` created from `main`. Fetch and verify the new
  stable tag, merge it without flattening upstream history, run the retained capability gates, and
  review the complete downstream diff before merging the candidate into `main`.
- Product work should be organized as focused commits after the baseline. Do not mix product
  behavior into an upstream import or upgrade merge.
- Never rewrite a published downstream `main` to adopt a new upstream tag.

## Verified environment

The initial verification used:

- macOS 15.6.1 (`24G90`)
- Xcode 16.4 (`16F6`)
- Apple Git 2.39.5
- Git LFS 3.7.1
- Node.js 24.18.0 from `.nvmrc`
- npm 11.16.0
- Electron 42.6.0 from the pinned package configuration

Use `nvm install` and `nvm use` from the repository root before dependency or build commands.

## Reproducible setup and build

```bash
nvm install
nvm use
npm install
npm run gulp compile
```

`npm install` installs root, build, remote, extension, and test dependencies through the upstream
postinstall. The Gulp `compile` target builds and type-checks the client and built-in extensions,
including `extensions/git`.

Launch the source build with an isolated profile when validating the baseline:

```bash
PROFILE_DIR="$(mktemp -d /tmp/repository-context-workbench-profile.XXXXXX)"
EXTENSIONS_DIR="$(mktemp -d /tmp/repository-context-workbench-extensions.XXXXXX)"
./scripts/code.sh \
  --user-data-dir "$PROFILE_DIR" \
  --extensions-dir "$EXTENSIONS_DIR" \
  --disable-extensions \
  --disable-workspace-trust \
  --skip-welcome \
  --skip-release-notes \
  --new-window
```

The initial run downloaded the pinned Electron build and upstream built-in extensions, created the
Code OSS application bundle, initialized the isolated profile, started the renderer and extension
host, and activated the built-in Git extension. Upstream emitted inactive-agent and proposed-API
diagnostics that did not prevent launch; these are baseline observations, not downstream changes.

## Test command inventory

Run compilation or type checks before tests.

| Scope | Command |
| --- | --- |
| Client type check | `npm run typecheck-client` |
| Built-in Git compile | `npm run gulp compile-extension:git` |
| All client and built-in extensions | `npm run gulp compile` |
| Targeted SCM graph unit test | `./scripts/test.sh --run src/vs/workbench/contrib/scm/test/browser/scmHistory.test.ts` |
| All Electron unit tests | `./scripts/test.sh` |
| All Node.js unit tests | `npm run test-node` |
| Browser unit tests on macOS CI browser | `npm run test-browser-no-install -- --browser webkit` |
| Built-in Git integration suite | `VSCODE_SKIP_PRELAUNCH=1 ./scripts/test-integration.sh --suite git` |
| All Electron integration suites | `VSCODE_SKIP_PRELAUNCH=1 ./scripts/test-integration.sh` |
| Browser integration suites | `./scripts/test-web-integration.sh --browser webkit` |
| Compile smoke harness | `npm --prefix test/smoke run compile` |
| Compile Copilot extension for baseline smoke | `npm --prefix extensions/copilot run compile` |
| Electron smoke suite | `npm run smoketest-no-compile -- --tracing` |
| Browser smoke suite | `npm run smoketest-no-compile -- --web --tracing --headless` |

The dedicated integration harness is required for built-in Git tests because they import the
extension host's `vscode` module. Direct execution with plain Mocha is not a supported seam.

## Initial verification evidence

| Check | Result |
| --- | --- |
| Dependency installation | Passed; tracked files unchanged |
| `npm run gulp compile` | Passed in 45 seconds with zero compilation errors |
| Isolated source launch | Passed; app bundle, profile, renderer, extension host, and Git extension observed |
| SCM history unit test | 12 passing |
| Built-in Git integration suite | 57 passing, including status, diff, stage, commit, outgoing state, and rename/delete conflict |

Generated dependencies, compilation output, downloaded Electron artifacts, test logs, and isolated
profiles are disposable and are not part of the downstream source baseline.
