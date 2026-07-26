# MCP client configuration contracts

Snapshot: 2026-07-26. This note covers the current stable releases of Codex, Claude Code, and Cursor. It uses only first-party specifications, documentation, release artifacts, and package registries.

## Product decision

Use one canonical definition and a versioned adapter per client. Do not treat any client's file format as the canonical model.

- Model a server as either `localProcess` or `remoteEndpoint`. Keep runtime state, authentication state, and discovered capabilities outside the definition.
- `enabled` means installed but not started. `selectedClients` is a helper-app projection policy; it is not a portable MCP field.
- Resolve global and repository definitions in the helper before projection. Use whole-entry repository override by stable ID, retain the shadowed origin, and never depend on undocumented client merge behavior.
- Project files may contain environment-variable names or secret references, but never credentials. Store credential values in the OS keychain or a private machine store.
- Preserve unknown native fields on read/write. Current documentation and released schemas already diverge in places.

The protocol baseline is [MCP 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18). Its current transports are stdio and Streamable HTTP; the older HTTP+SSE transport was superseded. Stdio messages are newline-delimited JSON-RPC and stdout must contain no non-MCP output. Streamable HTTP uses one endpoint for POST and optional GET/SSE responses. Local servers should bind to loopback, validate `Origin`, and authenticate where appropriate. There is no standard `/health` endpoint. Health is inferred from initialization and capability/list requests. See the official [transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports), [lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle), and [server capability](https://modelcontextprotocol.io/specification/2025-06-18/server) specifications.

## Native configuration matrix

| Client | Local process | Remote endpoint | User/global | Repository/project |
| --- | --- | --- | --- | --- |
| Codex | `[mcp_servers.<id>]`, `command`, optional `args`, `cwd`, `env`, `env_vars` | `url`; optional `auth`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, `scopes`, `oauth_resource` | `~/.codex/config.toml` | `<repo>/.codex/config.toml`, trusted projects only |
| Claude Code | `{ "type": "stdio", "command": ..., "args": [], "env": {} }` | `{ "type": "http", "url": ..., "headers": {} }`; `streamable-http` alias; deprecated `sse` remains supported | `~/.claude.json` | `.mcp.json`; local private scope is stored under the absolute project path in `~/.claude.json` |
| Cursor | `mcpServers.<id>` with `type: "stdio"`, `command`, optional `args`, `env`, `envFile` | `url`, optional `headers` and OAuth `auth`; HTTP/SSE is inferred from the endpoint | `~/.cursor/mcp.json` | `.cursor/mcp.json` |

Sources: [Codex MCP guide](https://developers.openai.com/codex/mcp/), [Codex configuration](https://developers.openai.com/codex/config-basic/), [Claude Code MCP](https://code.claude.com/docs/en/mcp), and [Cursor MCP](https://cursor.com/docs/mcp).

### Codex

Codex supports stdio and Streamable HTTP. Common fields include `enabled`, `required`, `startup_timeout_sec` (default 10), `tool_timeout_sec` (default 60), `enabled_tools`, and `disabled_tools`; the deny list is applied after the allow list. `enabled = false` retains the definition. The CLI supports `codex mcp add|get|list|remove|login|logout`; `add` and `remove` operate on the user-global configuration. `/mcp` and the desktop/IDE settings expose enabled and authentication state. The [configuration reference](https://developers.openai.com/codex/config-reference/) is the detailed field source.

Effective configuration precedence is: CLI flags/`--config`, project files from repository root toward the current directory with the nearest winning, profile, user file, `/etc/codex/config.toml`, then defaults. Project files load only for trusted projects. Managed requirements may additionally force a server off unless its name and command or URL are allowlisted.

For native status rather than file inspection, the [Codex App Server protocol](https://developers.openai.com/codex/app-server/) provides `config/read`, `config/mcpServer/reload`, `mcpServerStatus/list`, startup-status notifications, OAuth login/completion, resource reads, and tool calls. Generate a schema matching the installed binary with `codex app-server generate-json-schema` or `generate-ts`.

Important version caveat: in 0.145.0, released schema/source includes fields such as `oauth.client_id`, `environment_id`, and `supports_parallel_tool_calls`, while mutable documentation contains at least one field not represented identically in that schema. Treat the versioned [0.145.0 configuration schema](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/core/config.schema.json) and [MCP types](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/config/src/mcp_types.rs) as the fixture contract and preserve unknown TOML keys.

### Claude Code

Claude Code has three user-controlled scopes:

- `local` is project-specific and private, stored inside `~/.claude.json`.
- `project` is `.mcp.json`, intended for version control and subject to user approval.
- `user` is cross-project in `~/.claude.json`.

Whole-server precedence is local, project, user, plugin, then claude.ai connector. Duplicate regular entries resolve by name; plugin and connector collisions resolve by endpoint. Definitions are not field-merged. `/mcp` can disable a server without removing it. Runtime enablement uses per-project `disabledMcpServers` for normally-on servers and `enabledMcpServers` for normally-off built-ins; project-file approval has separate allow/reject state. `claude mcp list|get|remove` and `/mcp` expose configuration and connection status.

Interpolation supports `${VAR}` and `${VAR:-default}` in process and remote fields. Missing variables without defaults may leave an unexpanded literal after a warning, so projection must validate them first. `headersHelper` runs an arbitrary shell command whenever headers are generated, overrides same-name static headers, and is trust-gated for local/project use. Treat it as executable code, not data. OAuth tokens are stored and refreshed separately; client secrets use the system keychain on macOS or a credentials file, not project configuration. These behaviors and the deprecated SSE status are documented in [Claude Code MCP](https://code.claude.com/docs/en/mcp).

### Cursor

Cursor supports stdio, SSE, and Streamable HTTP, plus Tools, Prompts, Resources, Roots, Elicitation, and MCP Apps. Configuration interpolation includes `${env:NAME}`, `${userHome}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, and path-separator variables. `envFile` is stdio-only. Static OAuth metadata may be represented under `auth`, but secrets should be interpolated rather than committed. Cursor uses fixed desktop and web OAuth callback URLs documented in [Cursor MCP](https://cursor.com/docs/mcp).

The Customize sidebar toggle retains a disabled definition but prevents it from loading or appearing in chat. Current CLI commands include `agent mcp list`, `list-tools`, `login`, `enable`, and `disable`; see the [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters). Current documentation does not define an `enabled` property inside `mcp.json`, a portable selected-tool list, the storage location of toggle state, or precedence when global and project files contain the same server name. The helper must not invent or depend on those behaviors.

## Authentication and secret boundaries

| Mechanism | Safe canonical content | Risk |
| --- | --- | --- |
| Stdio environment | Variable name or secret reference | Literal `env` values leak through project files, process launch data, logs, or exports |
| Remote bearer/header | Environment-variable name or secret reference | Literal headers/tokens leak through files, JSON CLI output, telemetry, or error snapshots |
| OAuth | Provider metadata and an opaque connection reference | Access/refresh tokens, client secrets, and callback state are machine/user-specific |
| Helper health cache | Status, timestamps, server identity, capability names | Tool schemas and server instructions may themselves contain sensitive organizational data |

Codex provides `bearer_token_env_var` and `env_http_headers`; prefer these over literal `env` and `http_headers`. Its `mcp_oauth_credentials_store` supports `auto`, `file`, and `keyring`; prefer `keyring`, because `auto` may fall back to `$CODEX_HOME/.credentials.json`. Also treat `codex mcp list|get --json` as sensitive: released 0.145.0 can expose literal environment and header values even when human-readable output masks them.

Claude's static arguments, headers, and `headersHelper` output require the same redaction policy. Cursor's `envFile` must not become a repository credential carrier. For every client, the canonical repository layer should reject literal credentials rather than merely warn.

## Health and capability discovery

Store this as noncanonical runtime telemetry:

```text
disabled | starting | connected | needsAuth | failed | stale
protocolVersion, serverInfo, instructions
tools, resources, prompts, listChanged support
lastAttemptAt, lastSuccessAt, sanitizedError
```

A direct probe should perform MCP initialization, honor negotiated capabilities, then call the supported `tools/list`, `resources/list`, and `prompts/list` methods with bounded timeouts. Refresh on the corresponding list-changed notifications. Do not call a guessed `/health` URL. Client-native views are useful corroboration, not the portable source of truth:

- Codex: App Server `mcpServerStatus/list` and startup-status notifications; `codex mcp list --json` alone is configuration/auth state, not a complete health probe.
- Claude Code: `/mcp`, `claude mcp list`, and dynamic `list_changed` refresh.
- Cursor: `agent mcp list`, `agent mcp list-tools <id>`, and Output → MCP Logs.

Never commit health results, OAuth status, discovered instructions, or cached tool schemas.

## Terminology

These are distinct product concepts:

- **MCP server**: a technical endpoint/process exposing MCP capabilities.
- **MCP integration**: this product's umbrella for a canonical server definition, its scope, client projections, and runtime status. It is not a standardized MCP entity.
- **Connection**: a machine/user-specific authenticated binding to a remote service. It is state attached to an integration, not a shareable definition.
- **Plugin**: an installable distribution bundle that may own skills, MCP servers/connectors, hooks, agents, or other components. Its owned server follows the plugin lifecycle, while authentication remains separate.

OpenAI currently describes plugins as bundles that can include skills, connectors, and MCP servers, while a connector is a product integration often backed by MCP; see [Plugins in Codex](https://developers.openai.com/codex/plugins/) and [Apps in ChatGPT](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt). Claude plugins can bundle MCP servers alongside skills, agents, hooks, and other components ([Claude plugins](https://code.claude.com/docs/en/plugins)); Cursor plugins likewise bundle rules, skills, agents, commands, hooks, and MCP servers ([Cursor plugins](https://cursor.com/docs/plugins)). Installing a plugin, defining a server, and connecting an account must remain three different actions in the UI.

## Version pins

| Surface | Fixture pin | Primary release source |
| --- | --- | --- |
| MCP | `2025-06-18` | [Specification](https://modelcontextprotocol.io/specification/2025-06-18) |
| Codex CLI | `0.145.0`, released 2026-07-21 | [OpenAI release](https://github.com/openai/codex/releases/tag/rust-v0.145.0) |
| Claude Code | npm `@anthropic-ai/claude-code@2.1.220`; `stable` tag was `2.1.212` at snapshot time | [npm version artifact](https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/2.1.220) |
| Cursor desktop, macOS arm64 | `3.13.10`, commit `4f02290ccd9304f0e6bf8ee85f6e9106f02ac1f7` | [Cursor stable download metadata](https://cursor.com/api/download?platform=darwin-arm64&releaseTrack=stable) |
| Cursor CLI installer | `2026.07.23-e383d2b` | [Cursor installer](https://cursor.com/install) |

Re-run all fixtures on client upgrade; mutable documentation is not a sufficient compatibility pin.

## Uncertainties

- Codex documentation does not state whether same-ID tables across layers merge by field or replace wholesale. Read the effective result through App Server `config/read`; do not reimplement the ambiguity.
- Codex guarantees shared local configuration across its surfaces, but does not clearly guarantee identical OAuth credential availability in every host context.
- Claude's current documented precedence is sufficiently explicit, but its enable/approval arrays are implementation state and should not become the canonical schema.
- Cursor does not document same-name global/project precedence, toggle-state persistence, or OAuth token storage. Treat these as observed, versioned adapter behavior only after fixture verification.
- Legacy SSE is required for current Claude/Cursor compatibility but is not a Codex transport. Keep it adapter-specific and deprecated in the canonical UI.

## Required compatibility fixtures

1. Pin the exact clients and protocol revision above, and record the detected version with each run.
2. Exercise a fake stdio server: initialize, stderr logging, stdout purity, tools/resources/prompts, list changes, timeout, malformed output, and crash.
3. Exercise Streamable HTTP: unauthenticated, bearer-env, env-derived custom header, OAuth-needed, JSON and SSE responses, session ID, and protocol-version header.
4. Exercise a legacy SSE fixture only against Claude and Cursor; Codex projection must report unsupported transport.
5. Create same-ID global/repository collisions. Verify the helper's whole-entry resolution, origin indicator, shadowed value, and Codex nested-project behavior. Record Cursor native behavior without making it canonical.
6. Verify disable retains an editable definition, starts no process/network request, and can be re-enabled.
7. Test all nonempty `selectedClients` combinations and confirm that no file or runtime state leaks into unselected clients.
8. Scan repository files, projections, logs, errors, and health caches for literal secrets.
9. Verify capability refresh, stale/error recovery, and restart without committing runtime data.
10. Verify plugin-owned server provenance, plugin enablement, and missing/present authentication as separate states.
