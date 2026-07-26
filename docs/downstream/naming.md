<!--
  Copyright (c) Microsoft Corporation. All rights reserved.
  Licensed under the MIT License. See License.txt in the project root for license information.
-->

# RepoBud Naming Contract

RepoBud is the single downstream product identity. Product-owned identifiers derive from the
display name or its lowercase machine slug:

| Surface | Canonical value |
| --- | --- |
| Product and application bundle | `RepoBud` |
| Repository and package slug | `repobud` |
| macOS bundle identifier | `dev.htjun.repobud` |
| URL protocol | `repobud` |
| Product data directory | `.repobud` |
| Shared data directory | `.repobud-shared` |
| Repository configuration directory | `.repobud` |
| Plugin manifest | `repobud-plugin.json` |
| Plugin install record | `.repobud-install.json` |
| Product configuration key | `repoBud` |
| Environment-variable prefix | `REPOBUD_` |

The lowercase phrase “repository context” remains valid domain language when it describes the
currently active repository and is not used as a product identity.

The `VSCode-darwin-arm64` package output directory and retained `code-oss-dev` identifiers inside
upstream build fixtures are Code OSS implementation details. They are not exposed as RepoBud
product identity and remain unchanged to reduce downstream upgrade conflicts.

This pre-release rename does not preserve aliases for the former working identity. Preview profiles,
repository configuration, plugin manifests, command identifiers, IPC channels, and test fixtures
must use the canonical RepoBud values.
