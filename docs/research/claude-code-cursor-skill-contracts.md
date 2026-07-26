# Claude Code and Cursor Skill Contracts

Research snapshot: 2026-07-26

Scope: official product documentation, official release metadata, and the
official Agent Skills specification only. This note records filesystem and
format contracts needed by the Skill projection adapters; it does not describe
observed behavior from community tools.

## Decision summary

- Keep the canonical skill in the portable Agent Skills format. Require
  `name` and `description`, even though Claude Code can infer either one.
- Store client-only frontmatter outside the canonical file and render it into
  client projections. The official strict validator rejects unknown overlay
  fields.
- Treat `.agents/skills/` as Cursor's preferred project and user projection
  root. Cursor reads it directly, so a separate `.cursor/skills/` copy is not
  necessary.
- Project each Claude Code skill directory into `.claude/skills/<name>` or
  `~/.claude/skills/<name>`. Claude Code explicitly supports a skill directory
  entry being a symlink and deduplicates the same resolved target.
- Do not claim that Cursor supports skill-directory symlinks or a particular
  winner for duplicate names. Neither behavior is specified in its current
  documentation. Keep copy fallback and collision fixtures for Cursor.
- Do not project the same skill into every compatible Cursor root. Cursor scans
  `.agents`, `.cursor`, `.claude`, and `.codex` roots; redundant projections can
  create an undocumented duplicate-name collision.
- Model client additions as overlays and compatibility badges, not rewrites of
  the canonical `SKILL.md`.

## Discovery contract

| Client | Project locations | User/global locations | Nested discovery | Official duplicate behavior |
| --- | --- | --- | --- | --- |
| Claude Code | `.claude/skills/<name>/SKILL.md`; plugin `skills/<name>/SKILL.md` | `~/.claude/skills/<name>/SKILL.md`; enterprise managed skills | Searches the starting directory and parents to the repository root, then discovers nested `.claude/skills/` as files are used. Nested same-name skills get directory-qualified names. | Enterprise overrides personal; personal overrides project; any of those overrides bundled. Plugin skills are namespaced. A skill overrides a legacy command of the same name. |
| Cursor | `.agents/skills/` and `.cursor/skills/`; compatibility roots `.claude/skills/` and `.codex/skills/` | `~/.agents/skills/` and `~/.cursor/skills/`; compatibility roots `~/.claude/skills/` and `~/.codex/skills/` | Recursively walks each skills root. It also discovers `.agents/skills/` and `.cursor/skills/` below the repository and scopes those skills to the containing subtree. | Not documented for user vs project, primary vs compatibility roots, or duplicate leaf names. |

Claude Code's current precedence is important for the product model: a native
personal skill wins over a project skill with the same command name. A UI that
promises "repository override wins" cannot achieve that by projecting both
native locations unchanged. It must either avoid the collision, project the
effective set per repository, namespace one entry, or show that the personal
entry shadows the repository entry.

The Agent Skills client implementation guide recommends the opposite default,
project over user, as an implementation convention. That guidance is not part
of the file-format specification and does not override Claude Code's documented
behavior. Cursor does not say whether it follows the recommendation.

Cursor's compatibility roots also couple otherwise separate adapters. Once a
Claude or Codex projection exists, Cursor may discover it too. Until an official
collision rule exists, report all discovered roots and avoid presenting one as
the authoritative Cursor winner.

Sources:

- [Claude Code: Where skills live and discovery](https://code.claude.com/docs/en/skills#where-skills-live)
- [Cursor: Skill directories](https://cursor.com/docs/skills#skill-directories)

## Directory symlinks

Claude Code explicitly documents this contract:

- A `<skill-name>` entry in enterprise, personal, or project skill locations
  may be a symlink to a directory elsewhere on disk.
- Claude Code follows the symlink to read `SKILL.md`.
- If the same resolved target is reachable from multiple locations, it loads
  the skill once.
- The statement applies to the individual `<skill-name>` entry. It does not
  promise that the whole `.claude/skills` root may be a symlink.
- Plugin symlinks have a separate marketplace-specific contract.

Cursor's Skill documentation does not mention symlinks. Its recursive directory
walk and compatibility roots are not enough to infer a stable symlink contract,
because traversal and deduplication are implementation choices. The Cursor
adapter should therefore prefer a symlink only behind a pinned-client fixture,
retain managed-copy fallback, and label symlink support as tested rather than
documented.

Sources:

- [Claude Code: Skill directory symlinks](https://code.claude.com/docs/en/skills#where-skills-live)
- [Cursor: Agent Skills](https://cursor.com/docs/skills)

## Portable format and overlays

The Agent Skills specification defines a directory with `SKILL.md`, optional
supporting resources, and progressive disclosure. Its portable frontmatter is:

| Field | Portable contract |
| --- | --- |
| `name` | Required; 1-64 lowercase alphanumeric characters and hyphens; no leading, trailing, or consecutive hyphen; must match the parent directory. |
| `description` | Required; 1-1024 characters; says what the skill does and when to use it. |
| `license` | Optional. |
| `compatibility` | Optional; 1-500 characters for product or environment requirements. |
| `metadata` | Optional string-to-string mapping. |
| `allowed-tools` | Optional space-separated string; experimental and client support may vary. |

The portable optional directories are `scripts/`, `references/`, and `assets/`.
References should be relative to the skill root.

### Shared current extensions

Both current Claude Code and Cursor docs support:

- `paths`: comma-separated glob string or YAML list for file-scoped
  availability.
- `disable-model-invocation`: prevents automatic invocation while retaining
  explicit `/skill-name` invocation.

These fields are client extensions, not fields in the current Agent Skills
specification. The pinned `skills-ref` validator rejects frontmatter outside
the specification's allowlist, so keep these fields in an overlay and add them
only when rendering a client projection. The UI should badge the result as a
"client extension" rather than strictly portable.

### Claude Code overlay

Claude Code additionally documents:

- `when_to_use`, `argument-hint`, and named `arguments`
- `user-invocable`
- `disallowed-tools`
- `model` and `effort`
- `context: fork`, `agent`, and `background`
- skill-scoped `hooks`
- `shell`
- argument and environment substitutions including `$ARGUMENTS`, `$0`,
  `${CLAUDE_SKILL_DIR}`, and `${CLAUDE_PROJECT_DIR}`
- shell-output preprocessing with inline or fenced `!` commands

Claude Code is more permissive than the portable specification: all fields are
optional, `name` defaults to the directory name, and `description` may fall
back to the first body paragraph. The canonical validator should not relax its
portable requirements to match this client convenience. Conversely, Claude
Code's frontmatter table does not list the standard `license`, `compatibility`,
or `metadata` fields, so their Claude-specific semantics are unspecified even
though they remain valid canonical data.

### Cursor overlay

Cursor documents only `name`, `description`, `paths`,
`disable-model-invocation`, and `metadata` in its frontmatter table. It also
accepts legacy `globs` as a fallback for `paths`; new skills should use `paths`.
Cursor documents recursive category folders and automatic subtree scoping for
nested project skill roots.

Cursor does not document Claude Code's invocation, subagent, hook, model,
argument-substitution, or shell-preprocessing features. The Cursor adapter
should mark those features as Claude-only rather than silently claiming
portability. Cursor also does not explicitly say whether the standard
`license`, `compatibility`, and experimental `allowed-tools` fields are
consumed, ignored, or rejected; preserve them, but report their Cursor behavior
as unspecified.

Sources:

- [Agent Skills specification, pinned source](https://github.com/agentskills/agentskills/blob/38a2ff82958afee88dadf4831509e6f7e9d8ef4e/docs/specification.mdx)
- [Agent Skills client implementation guide](https://agentskills.io/client-implementation/adding-skills-support#where-to-scan)
- [Pinned strict validator allowlist](https://github.com/agentskills/agentskills/blob/38a2ff82958afee88dadf4831509e6f7e9d8ef4e/skills-ref/src/skills_ref/validator.py#L14-L21)
- [Claude Code: Frontmatter reference](https://code.claude.com/docs/en/skills#frontmatter-reference)
- [Claude Code: Dynamic context injection](https://code.claude.com/docs/en/skills#inject-dynamic-context)
- [Cursor: SKILL.md format](https://cursor.com/docs/skills#skillmd-file-format)

## Release fixture pins

Use exact client versions in release smoke fixtures and record the documentation
snapshot date alongside them:

| Fixture | Pin | Reason |
| --- | --- | --- |
| Agent Skills validator/spec | commit `38a2ff82958afee88dadf4831509e6f7e9d8ef4e` (2026-07-10) | Exact source revision behind the portable format assertions. |
| Claude Code | `@anthropic-ai/claude-code@2.1.220` (published 2026-07-24) | Current package on the research date and new enough for documentation marked `v2.1.218+`. The npm `stable` tag was still `2.1.212`, which is too old for the complete current overlay fixture. |
| Cursor macOS arm64 | `3.13.10`, commit `4f02290ccd9304f0e6bf8ee85f6e9106f02ac1f7` | Exact stable artifact returned by Cursor's official download API on 2026-07-26. |

Cursor first announced Agent Skills in editor and CLI in Cursor 2.4 on
2026-01-22. That is a historical minimum, not a sufficient release pin for the
current discovery contract.

Sources:

- [Agent Skills repository revision](https://github.com/agentskills/agentskills/commit/38a2ff82958afee88dadf4831509e6f7e9d8ef4e)
- [Claude Code package metadata](https://registry.npmjs.org/@anthropic-ai/claude-code)
- [Cursor stable download metadata](https://cursor.com/api/download?platform=darwin-arm64&releaseTrack=stable)
- [Cursor 2.4 release announcement](https://cursor.com/changelog/2-4)

## Required compatibility badges and fixtures

Recommended badges:

- `Portable`: only current Agent Skills fields and resources.
- `Shared extension`: uses `paths` or `disable-model-invocation`.
- `Claude Code`: uses any Claude-only overlay or preprocessing syntax.
- `Cursor legacy`: uses `globs`.
- `Unverified in Cursor`: depends on symlink traversal, duplicate precedence,
  or a standard optional field that Cursor does not document.

Pinned release fixtures should cover:

1. Discovery from each documented global and project root.
2. Claude leaf-directory symlink discovery and same-target deduplication.
3. Cursor symlink versus managed-copy behavior, recorded as tested behavior for
   the pinned build only.
4. Duplicate names across global/project roots and across Cursor's primary and
   compatibility roots.
5. A portable skill with all standard optional fields.
6. Shared-extension skills using `paths` and manual-only invocation.
7. Claude-only substitutions, shell preprocessing, hooks, and forked context.
8. Nested monorepo discovery and file-scope behavior in both clients.

## Explicit uncertainties

- Cursor publishes no Skill collision or precedence contract. Any observed
  winner is version-specific until documented.
- Cursor publishes no Skill symlink contract or same-target deduplication
  contract.
- Cursor's frontmatter table omits several standard optional fields, so their
  semantic support is unspecified even though a YAML parser may tolerate them.
- Claude Code's docs guarantee symlinks for leaf skill entries, not for the
  whole skills root.
- The Agent Skills format does not standardize discovery paths, precedence,
  installation, activation controls, or client-specific preprocessing. Those
  remain adapter contracts. Its implementation guide describes
  `.agents/skills/` as an interoperability convention, not a mandated path.
