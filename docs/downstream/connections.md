# Authenticated Connections

A Connection is a machine-local authenticated account used by an Integration. Installing an
Integration, activating it for a repository, selecting clients, connecting an account, and
installing a Plugin are independent actions.

## GitHub tracer

The first provider-specific tracer accepts a GitHub.com personal access token and validates it with
`GET https://api.github.com/user`. Requests pin GitHub REST API version `2026-03-10`, use the
documented media type, and send an explicit product user agent. The returned numeric user ID is the
stable account identity; the login is display metadata.

One Integration can retain multiple GitHub account descriptors. With one account and no explicit
selection, that account is selected automatically. With multiple accounts and no selection, the
Integration reports `Needs attention` instead of guessing.

## Selection precedence

The effective Connection resolves in this order:

1. The active repository's opaque Connection reference in `.repository-context/config.json`.
2. The global default reference in `repository-context.json`.
3. The only compatible machine-local Connection, when exactly one exists.

A repository selection does not modify the global default. Removing the repository selection
restores inheritance.

## Secret boundary

Portable configuration contains only a random opaque identifier such as
`conn_5d51c3df978b44fe8b51bbc3491b20f3`. Account labels, validation state, scopes, timestamps, and
expiry evidence are machine-local metadata.

The token itself is stored as the protected value of a macOS Keychain generic-password item. The
Keychain service is derived from the product bundle identifier, and the opaque Connection
identifier is the item account. The renderer reaches the narrow Keychain service over main-process
IPC; it does not invoke a shell or write token-derived ciphertext to application-state files.

This intentionally does not use Code OSS `ISecretStorageService`. That service is secure encrypted
file storage backed by a Keychain-held encryption key, but it does not satisfy this product's
stricter requirement that token material itself live only in Keychain.

## Attention and lifecycle states

Known expiry, credential rejection, missing Keychain data, identity mismatch, and ambiguous
selection all produce `Needs attention`. GitHub `401` without a known past expiry is called
`rejected`, not `revoked`, because GitHub cannot prove whether the cause was revocation, malformed
input, or another invalidation event.

`Disconnect` deletes the Keychain value and leaves the machine-local descriptor, opaque selection,
Integration, and Plugin intact. Reconnecting the same GitHub identity restores the existing
Connection reference. Uninstalling an Integration or Plugin is a separate lifecycle operation.

The official-source contract review, rate-limit guidance, Enterprise URL model, and OAuth
follow-ups are recorded in
`docs/research/github-token-connections-and-macos-keychain.md`.
