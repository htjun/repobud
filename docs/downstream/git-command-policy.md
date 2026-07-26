# Git Command Policy

The built-in Git manifest is the authoritative command declaration list for the pinned downstream
baseline. RepoBud classifies every declared `git.*` command as:

- **supported** — a user-facing Git operation retained by the focused product;
- **internal** — a helper command retained for SCM, diff, or extension API implementation; or
- **excluded** — an operation that conflicts with the one-active-repository, read-only viewer
  boundary.

Run the policy checker to verify the complete inventory:

```bash
npm run check-git-command-policy
```

Add `-- --report` to print a row for every command:

```bash
npm run check-git-command-policy -- --report
```

The checker pins both the count and SHA-256 digest of the sorted command IDs, verifies that every
explicitly classified command still exists, and ensures every excluded command is blocked by the
product command service. Any upstream command addition, removal, or rename therefore requires a
deliberate policy review.

## Product boundaries

- Repository open, clone, initialize, and active-context lifecycle are reached through the
  repository catalog. Internal Git commands remain available to that implementation.
- Source files and diffs are read-only. Confirmed SCM discard remains supported, while direct file
  rename, delete, range revert, and merge-editor commands are excluded.
- Branches, worktrees, tags, stashes, commit variants, graph actions, and remote operations remain
  supported.
- Timeline, remote edit-session continuation, and multi-repository discovery are excluded.
- Commands classified as supported do not imply that destructive behavior is unguarded. Amend,
  rebase, branch/worktree deletion, discard/clean, and force push have product-specific review
  boundaries.
- The pinned Git extension declares no hard-reset command, and no product menu or command reaches
  the internal hard-reset API. Adding such a command would change the pinned command digest and
  requires both a policy review and an explicit impact confirmation.
