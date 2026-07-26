# Code OSS Source Control Mini-App Research

Research baseline: VS Code `main` at `792a995` on 2026-07-25.

## Initial conclusion

Extracting the VS Code Source Control view into an independent mini-app is technically possible,
but the view is not an independently distributable component. Rebuilding equivalent behavior on a
separate Git data layer and UI would avoid Workbench coupling, but it would also require recreating
a large and subtle Git feature surface.

The later product planning decision therefore selected a thin Code OSS downstream instead. The
downstream will retain upstream SCM behavior and remove unrelated product reachability through
composition seams rather than extracting the SCM UI or broadly deleting source.

## Evidence

- The Changes header, commit input, and action button are implemented by
  [`SCMViewPane`](https://github.com/microsoft/vscode/blob/792a995058e67c6b4f1e63384165f98827de2eb5/src/vs/workbench/contrib/scm/browser/scmViewPane.ts).
  The graph is implemented by
  [`SCMHistoryViewPane`](https://github.com/microsoft/vscode/blob/792a995058e67c6b4f1e63384165f98827de2eb5/src/vs/workbench/contrib/scm/browser/scmHistoryViewPane.ts).
- At that revision, each file was roughly 2,000 lines and imported dozens of Workbench services,
  including tree and list controls, dependency injection, commands, menus, themes, editors,
  storage, telemetry, and accessibility. Neither is an isolated UI package.
- This coupling follows the official Code OSS architecture: SCM is registered as a Workbench
  contribution. See the
  [source code organization](https://github.com/microsoft/vscode/wiki/source-code-organization)
  documentation.
- The UI does not calculate Git state directly. The built-in
  [Git extension](https://github.com/microsoft/vscode/tree/792a995058e67c6b4f1e63384165f98827de2eb5/extensions/git)
  invokes the system Git process. Its `repository.ts` maps Changes, Staged Changes, and Untracked
  Changes, commit actions, and history providers into the SCM model.
- Graph lane calculation and SVG rendering are relatively concentrated in
  [`scmHistory.ts`](https://github.com/microsoft/vscode/blob/792a995058e67c6b4f1e63384165f98827de2eb5/src/vs/workbench/contrib/scm/browser/scmHistory.ts),
  but still depend on internal models, DOM utilities, and theme services.
- The Git graph contract,
  [`scmHistoryProvider`](https://github.com/microsoft/vscode/blob/792a995058e67c6b4f1e63384165f98827de2eb5/src/vscode-dts/vscode.proposed.scmHistoryProvider.d.ts),
  is a proposed API. The built-in Git extension explicitly enables it, so SCM Workbench and Git
  extension upgrades must remain coupled. Proposed APIs are intentionally unstable; see the
  [official guidance](https://code.visualstudio.com/api/advanced-topics/using-proposed-api).

## Design considerations

1. **Application shape:** local repository access and Git process execution favor a desktop shell
   with a native backend. A browser-only application cannot provide the same scope.
2. **Feature completeness:** status, partial staging, commits, graph, push and pull, repositories,
   worktrees, submodules, merge and rebase state, conflicts, and destructive actions form one
   interdependent behavior surface.
3. **Git compatibility:** the product must define Git discovery, credential helper and signing
   behavior, hook execution, path encoding, and large-repository performance. Stable machine
   parsing should use porcelain output and NUL delimiters where applicable.
4. **Graph correctness:** fixtures must cover linear history, merges, multiple refs, tags, remotes,
   pagination, and stale state after fetch. The upstream SCM graph tests already cover several of
   these cases.
5. **Security:** commit and push can execute repository hooks. Repository trust, visible process
   state, cancellation, stderr handling, and confirmation for destructive operations are required.
6. **Licensing and branding:** Code OSS source is MIT licensed and requires preservation of
   notices. Visual Studio Code names and logos are separate trademarks and must not be reused for
   the downstream identity.
7. **Icons:** Codicon source icons are CC BY 4.0 while generated code is MIT licensed. Reusing icon
   assets requires the corresponding attribution.

## Adopted direction

Maintain a thin Code OSS downstream, keep the Workbench and built-in Git extension as one pinned
unit, and introduce product-owned composition and service boundaries around upstream SCM instead of
extracting the view. This maximizes behavioral fidelity for staged and unstaged changes, partial
staging, read-only diffs, commits, graph operations, branches, worktrees, and remotes.
