# MCP Integrations

The Integrations area resolves MCP servers for the one active repository. Server installation,
repository activation, client projection, runtime health, and account authentication are separate
states.

## Canonical definitions

Global definitions live in the selected configuration repository:

```text
integrations/<integration-id>.json
```

Repository definitions live with the project:

```text
.repository-context/integrations/<integration-id>.json
```

Each definition uses version `1` and one of two explicit transports:

```json
{
	"version": 1,
	"id": "local-files",
	"name": "Local files",
	"description": "Reads files from the active repository.",
	"transport": {
		"type": "stdio",
		"command": "node",
		"args": ["server.js"]
	}
}
```

```json
{
	"version": 1,
	"id": "remote-docs",
	"name": "Remote docs",
	"description": "Reads remote documentation.",
	"transport": {
		"type": "http",
		"url": "https://example.com/mcp"
	}
}
```

The strict schema rejects environment values, headers, tokens, OAuth material, and unknown fields.
Credentials belong to a machine-local Connection, not a portable server definition.

## Effective state

Activation and selected clients resolve independently:

1. A repository override in `.repository-context/config.json`.
2. The corresponding global value in `repository-context.json`.
3. `On` and all supported clients when neither scope supplies a value.

Removing a repository field restores only that inherited field. A disabled server remains in the
canonical library, appears under `Available`, and can be re-enabled or revealed for external
editing. Conflicting definitions and settings without definitions appear under `Needs attention`.

## Health boundary

Health checks are explicit user actions. A local process check first shows the exact command and
arguments, then starts the process without a shell and with a minimal environment. Remote checks
send MCP `initialize` to the configured Streamable HTTP endpoint. Both paths use a bounded timeout.

Protocol version, server capability names, timestamps, and sanitized errors live only in memory.
They are never written to the active repository or configuration repository. There is no invented
`/health` endpoint.

## Claude Code project projection

The first versioned adapter writes only selected, enabled definitions to the active repository's
documented Claude Code project file:

```text
<active-repository>/.mcp.json
```

The adapter preserves unrelated top-level fields and server entries. It blocks a same-ID entry that
differs from canonical content until the user explicitly confirms replacement. It emits only
`type`, `command`, `args`, or `url`; it never emits credentials.

Codex and Cursor remain independently selectable so activation policy is portable, but their
project adapters report `Unsupported` in this release rather than guessing at undocumented merge
or toggle behavior. Exact client and protocol pins live in
`src/vs/workbench/contrib/repositoryContext/test/fixtures/mcpProjectionClients.json`.

The primary-source contract review and unresolved client behavior are recorded in
`docs/research/mcp-client-configuration-contracts.md`.
