# Source Control Baseline Inventory

This inventory pins the upstream seams that the focused product must retain. It is not the final
supported-command decision; product composition work will classify each command as reachable or
intentionally excluded.

## Workbench SCM

| Concern | Upstream seam |
| --- | --- |
| Contribution registration | `src/vs/workbench/contrib/scm/browser/scm.contribution.ts` |
| Changes view, commit input, resource groups | `src/vs/workbench/contrib/scm/browser/scmViewPane.ts` |
| History graph view | `src/vs/workbench/contrib/scm/browser/scmHistoryViewPane.ts` |
| Graph lane and ref view models | `src/vs/workbench/contrib/scm/browser/scmHistory.ts` |
| SCM services and models | `src/vs/workbench/contrib/scm/common/` and `src/vs/workbench/services/scm/` |
| Graph tests | `src/vs/workbench/contrib/scm/test/browser/scmHistory.test.ts` |

The history provider crosses a proposed extension API boundary. The Workbench SCM contribution and
the built-in Git extension must therefore be pinned, upgraded, and tested as one unit.

## Built-in Git extension

| Concern | Upstream seam |
| --- | --- |
| Manifest, command and menu contributions | `extensions/git/package.json` |
| Repository state and Git process behavior | `extensions/git/src/repository.ts` |
| Repository discovery and lifecycle | `extensions/git/src/model.ts` |
| Command handlers | `extensions/git/src/commands.ts` |
| Git parsing and process adapter | `extensions/git/src/git.ts` |
| History provider | `extensions/git/src/historyProvider.ts` |
| Integration test entrypoint | `extensions/git/src/test/index.ts` |

At tag `1.130.0`, the manifest declares 183 `git.*` commands and 420 Git command or alternate-command
menu entries across 30 menu locations. These declarations include:

- open, clone, initialize, refresh, close, and worktree repository lifecycle;
- staged, unstaged, untracked, rename, delete, clean, and conflict operations;
- file, hunk, selected-range, and selection staging and unstaging;
- commit, amend, signed, staged, all, empty, and no-verify variants;
- branch, detached checkout, merge, rebase, cherry-pick, tag, and stash workflows;
- fetch, pull, push, force push, sync, publish, and remote management;
- history graph checkout, compare, delete, cherry-pick, and ref actions;
- diff, multi-diff, timeline, blame, and output actions.

Use the manifest as the authoritative declaration list. A reproducible count and exact ID list can
be extracted with:

```bash
node - <<'NODE'
const manifest = require('./extensions/git/package.json');
const commands = (manifest.contributes?.commands ?? [])
  .filter(item => item.command?.startsWith('git.'))
  .map(item => item.command);
const menus = Object.values(manifest.contributes?.menus ?? {})
  .flat()
  .filter(item => item.command?.startsWith('git.') || item.alt?.startsWith('git.'));

console.log(`commands=${commands.length}`);
console.log(`menuEntries=${menus.length}`);
console.log(commands.join('\n'));
NODE
```

## Retained baseline tests

The focused product depends first on these test seams:

- `scmHistory.test.ts`: empty, linear, branch, merge, color-map, local/remote, incoming/outgoing,
  and merged-incoming graph cases.
- `extensions/git/src/test/git.test.ts`: status parsing, rename parsing, remotes, commits, tree and
  file parsing, and co-author trailers.
- `extensions/git/src/test/repositoryCache.test.ts`: repository cache limits and URL normalization.
- `extensions/git/src/test/smoke.test.ts`: working-tree reflection, diff opening, staging, committing,
  outgoing state, and rename/delete conflict behavior.
- `scripts/test-integration.sh --suite git`: the supported Electron extension-host harness for the
  built-in Git test entrypoint.
- `test/smoke`: the upstream user-visible Electron and browser harness to reuse for the packaged
  focused shell.

## Upgrade gate

Every stable-tag upgrade must:

1. Re-extract command and menu declarations and review the delta.
2. Compile Workbench SCM and the built-in Git extension together.
3. Pass SCM graph and Git extension-host tests.
4. Run the downstream repository switching, read-only diff, and retained-command E2E tracers.
5. Record intentional additions, removals, and proposed API changes before the upgrade is accepted.
