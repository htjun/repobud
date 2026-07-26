# Context-first Skill Management

The Skills area always resolves capabilities for the one active repository. It does not show a
combined multi-repository library.

## Canonical definitions

Global definitions live in the selected configuration repository:

```text
skills/<skill-id>/SKILL.md
```

Repository definitions live with the project:

```text
.repository-context/skills/<skill-id>/SKILL.md
```

The directory name is the canonical Skill identity. `SKILL.md` uses YAML frontmatter with `name`
and `description` for presentation. A matching identity in both locations is a conflict and appears
under `Needs attention`; the repository definition never silently shadows the global definition.

## Effective activation

Activation is resolved in this order:

1. A repository `On` or `Off` entry in `.repository-context/config.json`.
2. The global `On` or `Off` default in `repository-context.json`.
3. `On` when neither configuration contains the Skill identity.

`Inherit` is represented by removing the repository entry. Definitions with missing metadata,
missing files, conflicting identities, or activation entries without definitions are unavailable
and appear under `Needs attention`.

The active-repository view groups the result into `Enabled`, `Available`, and `Needs attention`.
Each row shows its canonical origin independently from the activation source.

## Global library boundary

Global defaults are managed from the Skills overflow menu rather than primary navigation. This
keeps the current repository and its effective state as the default workflow while still allowing
the user-owned global library to be managed explicitly.

## Codex projection

An enabled, valid Skill can be projected to Codex from its active-repository row. The projection
always points at the complete canonical Skill directory, including scripts, references, assets, and
client metadata:

```text
Global origin:     ~/.agents/skills/<skill-id>
Repository origin: <active-repository>/.agents/skills/<skill-id>
```

Repository Context Workbench prefers a directory symlink so canonical content is not duplicated.
If the local filesystem does not support that link, it creates a managed copy and records
deterministic SHA-256 hashes for the canonical source and projected output. The manifest and target
path are machine-local application state; they are never written to either canonical Git
repository.

The Codex badge reports `Missing`, `Linked`, `Copied`, `Modified`, `Outdated`, or `Unsupported`.
An untracked or externally changed target is never overwritten automatically. `Import changes`
explicitly replaces canonical content with the target after validation. `Restore projection`
explicitly replaces the target from canonical content. Both operations require confirmation.
Use `Refresh Skills` after changing a projection outside the app. Restart Codex when its installed
Skill inventory does not update live.
