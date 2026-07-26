# Canonical Configuration

Repository Context uses user-owned Git repositories as the source of truth for portable Skills and
Integration activation. The application never commits or pushes these files automatically.

## Global repository

The selected global configuration repository contains a human-readable `repository-context.json`:

```json
{
	"version": 1,
	"scope": "global",
	"skills": {},
	"integrations": {}
}
```

The repository can be an existing Git repository or a folder initialized from the product. It is
also registered in the normal repository catalog. Its local URI is application machine state and
is stored outside the configuration repository.

## Repository-local configuration

A project can carry `.repository-context/config.json` with `scope` set to `repository`. This file
contains portable capability IDs and `on` or `off` activation values. It contains no absolute
paths, credentials, caches, health results, or other machine state, so a project can commit it
normally.

Removing a repository-level capability entry restores inheritance from the global configuration.
Client projections and their hashes are derived state and are not authoritative configuration.

## Write and validation boundary

Canonical JSON writes use the file service's atomic replace support and deterministic key ordering.
Readers reject unsupported versions, scopes, capability IDs, activation values, and additional
fields. In particular, credentials and machine-only state cannot be added to activation entries.

Secrets belong in macOS Keychain. Disposable indexes, projection health, file hashes, and local
repository pointers belong in application storage. Future canonical formats may contain opaque
credential references, but never credential material.
