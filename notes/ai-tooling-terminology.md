# AI Developer Tooling Terminology

Research date: 2026-07-26.

## Executive recommendation

Do not collapse `Skill`, `MCP server`, `Connection`, `Plugin`, and `Extension` into one concept. They represent different layers:

1. **Skill** — portable workflow knowledge and resources.
2. **MCP server** — a protocol endpoint or local process that exposes live tools, resources, and prompts.
3. **Connection** — an authenticated binding to a service account or tenant.
4. **Plugin** — an installable distribution bundle that can contain skills, MCP configuration, and other vendor-specific components.
5. **Extension** — executable code loaded by a host application such as VS Code.

Use **Integration** as the product-neutral umbrella for external-service capability, not as a replacement for these objects. Treat **App** and **Connector** as vendor-facing aliases imported by client adapters rather than canonical domain types.

## Boundaries

| Term | Recommended product definition | Standard status | Keep separate because |
| --- | --- | --- | --- |
| **Skill** | A directory of model instructions and optional scripts, references, templates, and assets for a repeatable workflow. | **Open format.** The Agent Skills specification defines a `SKILL.md` directory, required metadata, optional resources, and progressive disclosure. It does not mandate installation paths or every activation behavior. [Agent Skills overview](https://agentskills.io/home), [specification](https://agentskills.io/specification), [client implementation guide](https://agentskills.io/client-implementation/adding-skills-support) | It teaches *how to perform a workflow*; it is not a service endpoint or credential. |
| **MCP server** | A configured local process or remote endpoint speaking MCP. | **Open protocol.** MCP standardizes host/client/server roles, capability negotiation, transports, and primitives. Servers can expose tools, resources, and prompts. [MCP architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture), [server primitives](https://modelcontextprotocol.io/specification/2025-06-18/server/index) | It provides live or executable capability; it does not define a workflow package, installation catalog, or service account. |
| **Connection** | One authenticated binding between this user/workspace and an external service identity, including credential reference, granted scopes, health, and expiry. | **Not an AI-tooling standard.** OAuth concepts are standardized, and MCP defines an optional OAuth-based authorization flow for HTTP transports, but neither MCP nor Agent Skills defines a first-class object named `Connection`. [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) | A service or MCP definition can exist without credentials, and one definition can have multiple account/tenant connections. |
| **Plugin** | A versioned, installable bundle that distributes one or more capabilities. | **Shared industry pattern, not a shared package standard.** OpenAI, Anthropic, and Cursor all use the word for bundles, but their contents, manifests, scopes, and lifecycle are vendor-specific. [OpenAI plugin architecture](https://developers.openai.com/plugins/concepts/plugins), [Claude Code plugins](https://code.claude.com/docs/en/plugins), [Cursor plugins](https://cursor.com/blog/marketplace) | It is a delivery unit, not a runtime capability. Installing a plugin and authorizing its external services are distinct actions. |
| **App / Connector** | Imported label for a vendor-defined external-service integration. Internally, map it to an `IntegrationDefinition` plus zero or more `Connection` records and, where applicable, an MCP endpoint. | **Vendor-specific and unstable.** OpenAI renamed connectors to apps in 2025 and, as of July 2026, puts apps inside plugin listings; Anthropic uses “connector” for reviewed integrations backed by MCP infrastructure. [OpenAI apps](https://help.openai.com/en/articles/11487775-connectors-in), [OpenAI plugins](https://help.openai.com/en/articles/20001256), [Claude Code MCP](https://code.claude.com/docs/en/mcp) | The label may describe discovery, UI, sync, authentication, or an MCP-backed service depending on the vendor. It is unsafe as a canonical technical type. |
| **Extension** | Executable package loaded into a particular host runtime, reserved here for VS Code-compatible extensions. | **Host-specific API contract.** VS Code extensions declare a `package.json` manifest, activation events, contribution points, and executable entry points, and run in an extension host. [VS Code extension anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy), [extension host](https://code.visualstudio.com/api/advanced-topics/extension-host) | It can execute with host permissions and alter host behavior; a skill is mainly instructions/resources and an MCP server is an external protocol participant. |

## What is actually portable

### Agent Skills

Agent Skills is the strongest cross-client content format. The open specification defines the contents of a skill directory, while its implementation guide explicitly says installation locations are client choices. It describes `.agents/skills/` as an emerging interoperability convention, not a mandated part of the specification. [Agent Skills specification](https://agentskills.io/specification), [client implementation guide](https://agentskills.io/client-implementation/adding-skills-support)

Claude Code states that its skills follow the Agent Skills open standard while adding product-specific invocation control, subagent execution, and dynamic context injection. It supports personal, project, enterprise, and plugin scopes, and follows symlinks for personal and project skills. [Claude Code skills](https://code.claude.com/docs/en/skills)

Cursor states that it supports Agent Skills in its editor and CLI and distinguishes dynamically discovered skills from always-on rules. [Cursor skills announcement](https://cursor.com/changelog/2-4), [Cursor agent guidance](https://cursor.com/blog/agent-best-practices)

OpenAI states that its skills follow the Agent Skills open standard, and its plugin documentation defines skills as `SKILL.md` folders with optional scripts, references, templates, and assets. [OpenAI Skills](https://help.openai.com/en/articles/20001066), [OpenAI plugin skill model](https://developers.openai.com/plugins/concepts/skills)

**Product implication:** keep one canonical Agent Skills-compatible core and generate client overlays only for client-specific metadata or behavior. Do not claim that all client semantics are portable merely because the directory validates against the common specification.

### MCP

MCP standardizes communication between an AI host, one client connection per server, and servers exposing protocol capabilities. It deliberately does not define how the host uses an LLM or manages supplied context. [MCP architecture overview](https://modelcontextprotocol.io/docs/learn/architecture)

The protocol defines tools, resources, and prompts, plus optional authorization for HTTP transports. It does **not** standardize marketplace packaging, product-level enablement rules, repository/global configuration precedence, OS secret storage, or a universal `mcp.json` file schema. Those are host concerns. [MCP specification](https://modelcontextprotocol.io/specification/2025-06-18/index), [authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)

Claude Code, for example, adds local/project/user installation scopes and its own precedence rules; it can also receive MCP server configuration from plugins and Claude.ai connectors. These are Claude Code behaviors, not MCP protocol requirements. [Claude Code MCP scopes](https://code.claude.com/docs/en/mcp)

**Product implication:** the canonical object should be an `McpServerDefinition` plus product-owned activation and projection rules. Store transport and endpoint/process configuration separately from authentication connections.

## Vendor term comparison

### Plugin

There is meaningful convergence on **Plugin as bundle**:

- OpenAI defines a plugin as the package users discover, install, share, and publish. It may contain skills, an MCP server, and optional UI. [OpenAI plugin architecture](https://developers.openai.com/plugins/concepts/plugins)
- Claude Code plugins package skills, agents, hooks, MCP servers, LSP servers, monitors, binaries, and settings under a Claude-specific structure and manifest. [Claude Code plugin structure](https://code.claude.com/docs/en/plugins)
- Cursor plugins package skills, subagents, MCP servers, hooks, and rules. [Cursor plugin announcement](https://cursor.com/changelog/2-5)

The abstraction can therefore be used in the helper app, but only as a **distribution and lifecycle concept**. A canonical plugin manifest will require adapters because no cross-vendor plugin manifest or resolution protocol exists in these official sources.

### App and Connector

OpenAI currently defines an app as the integration that connects ChatGPT or Codex to external systems, data, and actions; plugins can include apps or depend on app templates. App access and action controls remain separate from plugin installation. [OpenAI apps](https://help.openai.com/en/articles/11487775-connectors-in), [OpenAI plugins](https://help.openai.com/en/articles/20001256)

Anthropic describes reviewed “connectors” as using the same MCP infrastructure available to Claude Code, while also allowing manually configured MCP servers. [Claude Code MCP](https://code.claude.com/docs/en/mcp)

This vocabulary is presentation-oriented and changes over time. The helper app should preserve vendor labels in adapter-specific detail views, but should not make `App` or `Connector` a universal storage type.

### Extension

VS Code extensions are broader and more privileged than AI workflow plugins: they can declare contributions, execute JavaScript through the VS Code API, and run in local, web, or remote extension hosts. VS Code also warns that installed extensions have the same permissions as VS Code itself. [Extension manifest](https://code.visualstudio.com/api/references/extension-manifest), [extension host](https://code.visualstudio.com/api/advanced-topics/extension-host), [extension marketplace security](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace)

Use `Extension` only for that host-native mechanism. A VS Code extension may contribute or bundle skills, but this does not make the extension itself a skill or a portable AI plugin.

## Proposed helper-app taxonomy

### Primary navigation

1. **Skills**
   - Canonical skill library
   - Global default and repository `Inherit / On / Off`
   - Origin, version, provenance, update diff, client compatibility
   - Shared core plus optional Codex, Claude Code, and Cursor overlays

2. **Integrations**
   - **MCP Servers:** server definitions, transports, health, capabilities, global/repository activation, and client targets
   - **Connections:** authenticated service-account or tenant bindings, scopes, expiry, reconnect, and disconnect
   - Show vendor `App` or `Connector` labels as aliases or provenance badges

3. **Plugins**
   - Install, update, disable, or uninstall bundles
   - Inspect included skills, MCP definitions, connection requirements, and vendor-specific components
   - Never imply that installing a plugin grants or creates a connection

4. **Extensions** (only if this product manages the retained VS Code extension host)
   - Separate security and compatibility surface for VS Code-compatible extensions
   - Do not mix extension enablement with skill or plugin activation

### Canonical entity relationships

```text
PluginPackage
  ├─ contains → SkillDefinition [0..n]
  ├─ contains/references → McpServerDefinition [0..n]
  ├─ requires → IntegrationDefinition [0..n]
  └─ may contain → ClientSpecificComponent [0..n]

IntegrationDefinition
  ├─ may be implemented by → McpServerDefinition [0..n]
  └─ has → Connection [0..n]

Connection
  └─ stores only a secure credential reference, never the secret itself
```

Activation belongs to definitions and repository/client projections. Authentication belongs to connections. Installation and update lifecycle belong to packages. Keeping these axes independent avoids the common failure where “disable plugin,” “disconnect account,” and “disable MCP server” accidentally mean the same destructive operation.

## Naming decisions to lock into the product

- Use **Skill** only for Agent Skills-compatible workflow content.
- Use **MCP Server** for a protocol configuration or endpoint; show `Local` or `Remote` as a transport/deployment property.
- Use **Connection** for an authenticated account/tenant instance.
- Use **Integration** for the external-service capability definition that connects MCP and credentials without conflating them.
- Use **Plugin** for an installable bundle; retain vendor plugin formats as projections.
- Use **App** and **Connector** only as imported vendor terminology or user-facing aliases.
- Use **Extension** only for executable VS Code-compatible extensions.
