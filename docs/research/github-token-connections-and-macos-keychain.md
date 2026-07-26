# GitHub token connections and macOS Keychain

Snapshot: 2026-07-26. This note uses GitHub, Apple, Electron, and Code OSS primary sources only. It covers the first token-based GitHub Connection tracer; OAuth registration remains a later product concern.

## Product decision

Use a random opaque `connectionRef` as the only credential locator in portable configuration. Keep the GitHub token in a dedicated macOS Keychain generic-password item, and keep non-secret connection metadata in machine-local application state.

Do not use Code OSS `ISecretStorageService` for this tracer if the requirement remains literally “token material is stored only in macOS Keychain.” Code OSS Secret Storage is secure encrypted file storage backed by a Keychain-held encryption key, not storage of each token as a Keychain item.

The first GitHub tracer should:

1. accept user-scoped personal access tokens, not installation tokens;
2. validate identity with `GET /user`;
3. optionally validate active-repository access with `GET /repos/{owner}/{repo}`;
4. bind a Connection to the immutable returned user ID and normalized API authority;
5. capture expiry, scope/permission hints, SSO hints, and rate-limit headers as noncanonical health data;
6. delete only the Keychain credential on disconnect, leaving the Integration or Plugin installed; and
7. never infer “revoked” when GitHub can only prove that a credential was rejected.

GitHub REST requests should pin API version `2026-03-10`, the current version in this snapshot. GitHub documents that requests without the version header fall back to `2022-11-28`; a removed version returns `410`. See [GitHub REST API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions?apiVersion=2026-03-10).

## GitHub validation contract

### Request

Use:

```http
GET /user HTTP/1.1
Accept: application/vnd.github+json
Authorization: Bearer <token>
X-GitHub-Api-Version: 2026-03-10
User-Agent: RepoBud/<version>
```

GitHub requires a valid `User-Agent`, recommends `application/vnd.github+json`, accepts `Bearer` for these tokens, and recommends an explicit API-version header. See [Getting started with the REST API](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api?apiVersion=2026-03-10) and [Authenticating to the REST API](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api?apiVersion=2026-03-10).

`GET /user` is the narrow identity probe:

- `200` returns `login`, numeric `id`, `node_id`, and public account metadata.
- `401` means the request requires authentication.
- `403` means forbidden and is not, by itself, proof of revocation.
- GitHub App user access tokens and fine-grained PATs require no fine-grained permission for this endpoint.
- OAuth tokens and classic PATs need the `user` scope only to include private profile fields, not to obtain the basic public identity used by this tracer.

See [Get the authenticated user](https://docs.github.com/en/rest/users/users?apiVersion=2026-03-10#get-the-authenticated-user).

The v1 token-entry UI should explicitly support:

- fine-grained personal access tokens;
- personal access tokens (classic).

Do not silently accept GitHub App installation tokens: `GET /user` does not list installation access tokens among its supported fine-grained token types, and an installation represents an installation rather than a human account. OAuth and GitHub App user flows should become separate credential issuers later rather than being guessed from a pasted string.

### Identity binding and multiple accounts

Model the stable GitHub account identity as:

```text
(providerId = "github", normalizedApiBaseUrl, authenticatedUser.id)
```

Use the numeric `id` as the stable identity. Treat `login` and `avatar_url` as display metadata that may change. Give every Connection an independently generated opaque reference such as `conn_01J...`; never derive that reference from a login, host, token prefix, or token hash.

Multiple accounts and tenants then remain explicit:

- Two GitHub.com users have different `connectionRef` values and different authenticated user IDs.
- The same username on GitHub.com and GitHub Enterprise Server is distinct because the normalized API base URL differs.
- GitHub Enterprise Server uses `https://HOSTNAME/api/v3`; GitHub Enterprise Cloud with data residency uses `https://api.SUBDOMAIN.ghe.com`. See [GitHub Enterprise Server REST authentication](https://docs.github.com/en/enterprise-server@3.19/rest/authentication/authenticating-to-the-rest-api) and [GitHub Enterprise Cloud data residency](https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency).
- An organization on GitHub.com is an authorization/resource boundary, not a distinct login authority. Do not duplicate one account per organization unless a later product model introduces an explicit organization context.

On first successful validation, bind the descriptor to the returned user ID. On later validation, a different returned user ID is `Needs attention: identity mismatch`; never silently rebind it. If multiple compatible Connections exist and neither a repository override nor a global default selects one, report `Needs attention: select an account` instead of guessing.

### Repository access probe

Identity validity and repository access are different checks. When the active repository has a recognized GitHub remote, optionally call:

```http
GET /repos/{owner}/{repo}
```

The endpoint requires read-level `Metadata` permission for a fine-grained PAT or GitHub App token when accessing private resources; public repositories can be read without it. See [Get a repository](https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10#get-a-repository).

A private repository may deliberately return `404` when authentication or permission is insufficient, so report `repository inaccessible or not found`, not a false certainty. GitHub documents this privacy behavior in [Troubleshooting the REST API](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api?apiVersion=2026-03-10#404-not-found-for-an-existing-resource).

Do not require the classic `repo` scope merely to validate an account. Request or recommend permissions only when a specific remote feature needs them:

- basic identity: no classic scope required for public identity; no fine-grained permission;
- private repository metadata: classic `repo`, or fine-grained repository `Metadata: read`;
- HTTP Git read/write with a future GitHub App token: the GitHub App documentation requires repository `Contents` permission.

Classic `repo` is broad: it grants full access to public and private repositories and additional organization-owned resources. See [OAuth app scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

### Scope and permission evidence

Treat scope data as observed diagnostics, never as canonical configuration:

- `X-OAuth-Scopes` lists scopes authorized for an OAuth token or classic PAT.
- `X-Accepted-OAuth-Scopes` lists OAuth scopes checked by the endpoint.
- `X-Accepted-GitHub-Permissions` lists permissions an endpoint requires for GitHub Apps and fine-grained PATs; it does **not** enumerate the permissions granted to the current token.

See [OAuth app scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps) and [Permissions required for fine-grained PATs](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens?apiVersion=2026-03-10).

For fine-grained PATs, prove required capability by making the narrow read request needed by the feature. Do not display an invented complete permission list.

If a classic PAT is blocked by SAML SSO, GitHub may return `403` with an `X-GitHub-SSO` authorization URL, or omit protected organizations and return `partial-results`. Surface this as `Needs attention: SSO authorization required`; do not classify it as a bad token. See [GitHub REST authentication with SAML SSO](https://docs.github.com/en/enterprise-cloud@latest/rest/authentication/authenticating-to-the-rest-api#personal-access-tokens-and-saml-sso).

### Expiry and revocation

GitHub tokens may become invalid because they expired, were revoked by the user/application/enterprise, were exposed in a public repository or gist, or were unused for a year. Expired or revoked tokens cannot be restored. See [Token expiration and revocation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation).

For PAT-backed connections:

- Parse `GitHub-Authentication-Token-Expiration` when present and persist only the timestamp as non-secret local metadata. GitHub introduced this response header specifically for PAT expiry; see the first-party [PAT expiration changelog](https://github.blog/changelog/2021-07-26-expiration-options-for-personal-access-tokens/).
- A known timestamp at or before the current time is `Needs attention: expired`.
- `401` after a previously working token is `Needs attention: credential rejected`. GitHub does not provide enough information in that response to distinguish revoked, expired, malformed, or otherwise invalid credentials.
- Absence of the expiry header means `expiry unknown`, not `never expires`.
- A network error or `5xx` is `temporarily unavailable`, not evidence that the credential is bad.

GitHub's unauthenticated `POST /credentials/revoke` endpoint is designed for credentials found exposed, is irreversible, accepts at most 1,000 credentials, is limited to 60 requests per hour, and rejects authenticated requests with `403`. It is not the normal implementation of “Disconnect.” See [Credential revocation](https://docs.github.com/en/rest/credentials/revoke?apiVersion=2026-03-10).

Product actions must remain distinct:

- **Disconnect**: delete the local Keychain secret and retain the Integration, Plugin, and non-secret Connection descriptor so the user can reconnect. Any selected `connectionRef` now resolves to `Needs attention: credential missing`.
- **Forget Connection**: clear or migrate affected defaults/overrides, delete its local descriptor, then delete its Keychain item.
- **Revoke on GitHub**: a separate, explicitly confirmed destructive action or a link to GitHub settings. Do not call the exposed-credential revocation endpoint implicitly.

### Rate-limit handling

Authenticated user requests normally share a 5,000-request-per-hour personal limit. Some GitHub Enterprise Cloud app-owned requests have a 15,000 limit. Every response can report:

```text
x-ratelimit-limit
x-ratelimit-remaining
x-ratelimit-used
x-ratelimit-reset
x-ratelimit-resource
```

`GET /rate_limit` does not consume the primary limit but can consume the secondary limit; GitHub recommends using response headers when possible. A primary-limit failure returns `403` or `429` with remaining `0`; secondary limits may include `Retry-After`. Do not retry until the indicated time, and use exponential backoff when GitHub instructs it. See [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2026-03-10).

The Connection tracer should validate on creation, explicit refresh, credential replacement, and a conservative stale interval. It should not poll continuously. Capture rate data as runtime health, never in portable configuration.

## Secret storage reality in Code OSS

### Electron `safeStorage`

Electron `safeStorage` encrypts strings for the caller to store. On macOS, the app's **encryption key** is stored in Keychain Access; `encryptString` returns an encrypted `Buffer`. Electron does not claim that the plaintext secret becomes an individual Keychain item. The current Electron documentation recommends its asynchronous APIs because they are non-blocking and support key rotation and temporary unavailability. See [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

This fork currently pins Electron `42.6.0` in `package.json`.

### Code OSS Secret Storage

Code OSS desktop Secret Storage uses Electron `safeStorage`, then stores the encrypted value through `IStorageService`:

- [`EncryptionMainService`](https://github.com/microsoft/vscode/blob/1b6a188127eeaf9194f945eb6eb89a657e93c54c/src/vs/platform/encryption/electron-main/encryptionMainService.ts) calls `safeStorage.encryptString` and `decryptString`.
- [`BaseSecretStorageService`](https://github.com/microsoft/vscode/blob/1b6a188127eeaf9194f945eb6eb89a657e93c54c/src/vs/platform/secrets/common/secrets.ts) writes the encrypted value to application storage with machine targeting.
- The official VS Code documentation describes Secret Storage as secrets encrypted before being stored on the filesystem, backed by Electron `safeStorage`; see [Remote extensions: Persisting secrets](https://code.visualstudio.com/api/advanced-topics/remote-extensions#persisting-secrets).
- The GitHub Authentication extension's class named `Keychain` delegates to `ExtensionContext.secrets`; it does not directly call Apple's Keychain API. See its pinned [`keychain.ts`](https://github.com/microsoft/vscode/blob/1b6a188127eeaf9194f945eb6eb89a657e93c54c/extensions/github-authentication/src/common/keychain.ts).

Therefore:

| Mechanism | What is in macOS Keychain | Where token-derived ciphertext is stored | Meets literal “token only in Keychain” |
| --- | --- | --- | --- |
| Electron `safeStorage` + app storage | App encryption key | Caller-selected file/database storage | No |
| Code OSS `ISecretStorageService` | Electron/Chromium safe-storage key | Code OSS application-state storage | No |
| Direct Keychain generic-password item | Token value as the item's protected secret data | Keychain encrypted database | Yes |

Code OSS Secret Storage is the official cross-platform recommendation and is materially safer than plaintext configuration. The distinction above is about the project's stricter storage-location acceptance criterion, not a claim that Code OSS Secret Storage is insecure.

## Recommended Keychain adapter

Use a narrow native adapter over Apple's modern `SecItemAdd`, `SecItemCopyMatching`, `SecItemUpdate`, and `SecItemDelete` APIs. Apple documents that Keychain Services encrypts the value data for password item classes and that `kSecClassGenericPassword` uses `kSecAttrService` and `kSecAttrAccount` in its composite primary key. See [Adding a password to the keychain](https://developer.apple.com/documentation/security/adding-a-password-to-the-keychain), [Keychain items](https://developer.apple.com/documentation/security/keychain-items), and [`kSecClassGenericPassword`](https://developer.apple.com/documentation/security/ksecclassgenericpassword).

Recommended item:

```text
kSecClass        = kSecClassGenericPassword
kSecAttrService  = "<product-bundle-id>.connections.github"
kSecAttrAccount  = connectionRef
kSecAttrLabel    = "RepoBud — GitHub — <display login>"
kSecValueData    = UTF-8 token bytes
```

Only `kSecValueData` contains the token. The service and account fields are stable lookup attributes. Use an app-owned native bridge rather than shelling out with a token in command arguments. Never enumerate, log, hash, export, or place the token in fixtures.

Use a fake in-memory adapter for deterministic unit/E2E tests and one isolated macOS integration test namespace. The packaged tracer should verify add/read/replace/delete without printing secret data, then delete its test item.

## Recommended domain contract

```ts
type ConnectionRef = string; // random opaque ID

interface GitHubConnectionDescriptor {
	readonly ref: ConnectionRef;
	readonly providerId: 'github';
	readonly apiBaseUrl: string;
	readonly credentialKind: 'fineGrainedPat' | 'classicPat';
	readonly account?: {
		readonly id: number;
		readonly nodeId: string;
		readonly login: string;
	};
	readonly label?: string;
	readonly expiresAt?: string;
}

interface ConnectionSelection {
	readonly defaultConnectionRef?: ConnectionRef;
	readonly repositoryConnectionRef?: ConnectionRef | null;
}
```

Resolution:

1. A repository `connectionRef` wins when present.
2. Explicit repository `null` means no Connection for that repository.
3. Otherwise inherit the global default.
4. A missing descriptor or Keychain item is `Needs attention`.
5. More than one candidate with no explicit selection is `Needs attention`; never select by “most recent.”

Portable global/repository configuration may contain only the opaque `connectionRef` selection. The token never appears in the canonical configuration repository, active repository, client projection, logs, errors, telemetry, screenshots, clipboard history generated by the app, or crash attachments.

Recommended runtime status:

```text
disconnected
checking
connected
needsAttention:
  credentialMissing
  credentialRejected
  expired
  identityMismatch
  ambiguousSelection
  repositoryInaccessible
  ssoAuthorizationRequired
temporarilyUnavailable:
  rateLimited
  network
  service
```

Health metadata is disposable machine state:

```text
lastAttemptAt, lastSuccessAt
authenticated account ID/login
expiry timestamp
observed OAuth scopes
accepted endpoint permissions/scopes
SSO hint
rate-limit limit/remaining/reset
sanitized error category
```

Never persist response bodies or headers wholesale: they may acquire sensitive fields over time.

## Required tracer fixtures

1. Two GitHub accounts under one Integration, with explicit global default and independent repository override.
2. Missing repository override inherits the global selection; explicit `null` selects none.
3. Missing Keychain item, rejected token, known expired timestamp, returned identity mismatch, and ambiguous selection each produce `Needs attention`.
4. `401`, SSO `403`, primary-rate `403/429`, private-resource `404`, `5xx`, timeout, malformed JSON, and API-version `410` remain distinguishable.
5. Classic PAT scope headers and fine-grained accepted-permission headers are displayed as different evidence.
6. Disconnect deletes only the Keychain value; Integration and Plugin installation/activation remain unchanged.
7. Repository files, canonical configuration, projections, logs, errors, screenshots, and artifacts are scanned for the fixture token and must contain no match.
8. A macOS-only packaged smoke test uses a unique Keychain service/account namespace and cleans up the item after verifying create/read/replace/delete.

## Uncertainties and release follow-ups

- GitHub does not provide a single token-introspection response that reliably distinguishes revoked, expired, malformed, SSO-blocked, and insufficiently authorized credentials. The product must preserve this uncertainty in its status language.
- Fine-grained PAT granted permissions are not exposed as a complete list by `GET /user`; endpoint success is the reliable capability proof.
- Product signing identity and Keychain access-control behavior must be reverified after the final bundle identifier, signing, and notarization inputs are available.
- OAuth should use a separately registered GitHub App or OAuth app, short-lived access/refresh semantics, PKCE/device-flow decisions, and a new credential issuer. Do not let the token-paste tracer predetermine that flow.
