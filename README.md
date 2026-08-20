# @hongyilyu/opencode-kiro-auth

> **Fork.** This is a fork of [toandev95/opencode-kiro-auth](https://github.com/toandev95/opencode-kiro-auth)
> by Toan Doan, published to npm because the upstream repo has fork pull requests
> disabled. It adds Claude Opus 5 / Fable 5 / Sonnet 5 and the GPT 5.6 models, wires
> opencode effort variants through to Kiro's `additionalModelRequestFields`, and authenticates
> directly with AWS Builder ID or IAM Identity Center. All upstream credit remains with the
> original author.

> **Disclaimer — use at your own risk.** This is an unofficial tool, not affiliated
> with Kiro/Amazon/AWS. Using a Kiro subscription outside its official client may
> violate the provider's Terms of Service and **could get your account suspended or
> banned**. It is intended for personal, local use only. You assume all risk.

Use Kiro models as an opencode provider with a direct AWS SSO OIDC login, or with a
long-lived API key from the Kiro web portal. These are two separate providers, so you can
configure both at once and pick per request:

| Provider | Credential | Use with |
| --- | --- | --- |
| `kiro` | AWS Builder ID or IAM Identity Center device flow | `--model kiro/claude-sonnet-4.6` |
| `kiro-api` | Long-lived `ksk_...` API key | `--model kiro-api/claude-sonnet-4.6` |

For the device flows the plugin dynamically registers its own OAuth client, runs the flow,
and stores the resulting credential in OpenCode's credential store. It never reads
kiro-cli files, databases, or keychains, and kiro-cli does not need to be installed.

## Setup

1. Add the plugin and the `provider` block to `~/.config/opencode/opencode.json`
   (see `opencode.example.jsonc`). Pick one plugin spec form:
   - npm: `"@hongyilyu/opencode-kiro-auth@latest"`
   - Git: `"github:hongyilyu/opencode-kiro-auth"` (optionally `#<tag>` to pin)
   - Local folder: `"file:///ABSOLUTE/PATH/TO/opencode-kiro-auth"`
2. Connect: `opencode auth login --provider kiro`.
3. Choose **AWS Builder ID** or **IAM Identity Center**. Identity Center also asks for
   your start URL and AWS region.
4. Open the displayed URL and approve the device code.
5. Run: `opencode run "hello" --model kiro/claude-sonnet-4.6`

Only one `provider` block (`kiro`) needs configuring. `kiro-api` mirrors its models
automatically, so both providers expose the same catalog.

When working from a source checkout, optional diagnostics are available:
`bun run check-auth` verifies the configured credential end to end, and
`bun run list-models` prints OpenCode's resolved Kiro model catalog. Neither command
is needed when using the plugin from npm.

### API key authentication (`kiro-api`)

The device-flow logins expire and must be refreshed; an API key does not, which makes it
the better fit for long-running or headless setups. Create one at
[app.kiro.dev](https://app.kiro.dev) under **Settings -> API Keys** (the full value is
shown only once), then:

```
opencode auth login --provider kiro-api
opencode run "hello" --model kiro-api/claude-sonnet-4.6
```

Because `kiro` and `kiro-api` are distinct providers, each keeps its own credential:
signing in to one never overwrites the other, and you can switch between them by changing
the model prefix.

`KIRO_API_KEY` is also honoured, matching [Kiro's headless
mode](https://kiro.dev/docs/cli/headless/), and is used when no `kiro-api` credential is
stored — handy in CI, where no interactive login is possible.

Requires a Kiro Pro, Pro+, Pro Max, or Power subscription, and if your subscription is
administered, API key generation must be enabled for your account. Keys are long-lived
credentials — store them like passwords, rotate them, and revoke a compromised key in the
portal immediately. Usage draws on the same subscription credits as an interactive login.

To customize `kiro-api` (for example to expose a subset of models), add a `kiro-api`
provider block; any field you set there takes precedence over the mirrored value.

### Migrating from 1.x

Versions through `1.2.0` stored only a sentinel in OpenCode and read kiro-cli's
credential at request time. That sentinel cannot be migrated because it contains no
refresh credentials. Run `opencode auth login --provider kiro` once after upgrading.

### Credential storage

For the device flows, the OAuth access token, refresh token, and dynamic client
registration are stored as the `kiro` provider credential by OpenCode, and refreshes are
written back through OpenCode's auth API. An API key is stored as the `kiro-api`
credential and never refreshed. Either way the credential is sensitive; do not share or
commit OpenCode's auth data.

## Models and effort

Model ids must match Kiro's `ListAvailableModels` exactly. Recent additions include
`claude-opus-5`, `claude-fable-5`, `claude-sonnet-5`, and `gpt-5.6-sol` /
`gpt-5.6-terra` / `gpt-5.6-luna`.

Effort is selected through opencode's variant picker (or `--variant <level>`). The
plugin forwards the chosen variant name to Kiro's `additionalModelRequestFields`:
`output_config.effort` for Claude models, `reasoning.effort` for GPT models. Models
without a variant selected send no effort field, leaving behavior unchanged.

## How it works

- `auth.ts` implements AWS SSO OIDC client registration, device authorization, and
  refresh using OpenCode-owned credentials.
- `apikey.ts` implements long-lived `ksk_...` API keys: validation, the `KIRO_API_KEY`
  fallback, the mandatory `tokentype: API_KEY` header, and profile lookup via
  `GetProfile` (API keys cannot call `ListAvailableProfiles`).
- `session.ts` is the seam between the two auth modes. It resolves each provider's
  credential to a `KiroSession` exposing auth headers and a profileArn, so the request
  and tool layers never branch on credential type or cross provider credentials.
- `profile.ts` resolves the profileArn for the device flows like kiro-cli: real ARN for
  accounts that have one, else the fixed Builder-ID placeholder. API keys bypass this,
  since the backend rejects a profileArn that isn't the key's own — their chat requests
  omit the field entirely.
- `transform.ts` maps the Anthropic Messages request opencode sends into Kiro's
  CodeWhisperer `GenerateAssistantResponse` request (text, tool calls, images), and
  converts the AWS event-stream response back into an Anthropic SSE stream. Before any
  output, throttling becomes HTTP 429, timeouts become HTTP 504, and a stream that ends
  without text or a tool call becomes HTTP 502, so opencode retries instead of recording
  a successful empty assistant turn. A terminal `CONTENT_FILTERED` event becomes a clear
  non-retryable HTTP 400, including Kiro's refusal category and recovery guidance, because
  retrying the same conversation cannot change the result.
- `plugin.ts` builds one plugin per provider from a shared factory and registers the
  opencode `auth` hook whose loader returns the intercepting `fetch`. Two plugin functions
  are exported — `KiroAuthPlugin` (`kiro`) and `KiroApiKeyPlugin` (`kiro-api`) — and
  opencode's legacy plugin loader loads every exported function, so both providers come
  from one package. The package entry point therefore intentionally exports functions only.
  The `kiro-api` plugin also uses the `config` hook to mirror the `kiro` model catalog.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `KIRO_API_KEY` | Unset | Long-lived `ksk_...` key used by the `kiro-api` provider when no credential is stored for it. See [API key authentication](#api-key-authentication-kiro-api). |
| `KIRO_RATE_LIMIT_RETRY_SECONDS` | Unset | Positive integer that overrides the retry interval for HTTP 429 and pre-output throttling responses. When unset or invalid, upstream `Retry-After` values and opencode's normal backoff are preserved. |
| `KIRO_KEEP_IMAGE_TURNS` | `2` | Number of recent image-bearing turns retained in requests. Set to `0` to strip all images. |
| `KIRO_DEBUG` | Unset | Set to `1` to write correlated request and event-stream diagnostics to stderr. Logs contain shapes and byte counts, not prompt text, tool output, credentials, or tokens. |

Example: `KIRO_RATE_LIMIT_RETRY_SECONDS=10 opencode`.

For a failing session, restart opencode with `KIRO_DEBUG=1` and capture stderr. Every
attempt uses the same trace UUID as its AWS SDK invocation ID, making retries and Kiro
request IDs easy to correlate.

## Large images and long sessions

Kiro caps the total size of a request (history plus images), returning a 400
`CONTENT_LENGTH_EXCEEDS_THRESHOLD` when exceeded. Because opencode resends the full
history — including every prior image — image-heavy sessions can hit this limit even
when the token count looks small. To avoid it, the plugin keeps images only on the most
recent image-bearing turns and replaces older ones with an `[image omitted]` marker.

- Tune with `KIRO_KEEP_IMAGE_TURNS` (default `2`; `0` strips all images).
- If a request still overflows, the error is surfaced as a context-overflow message, so
  opencode suggests starting a new session or running `/compact`.

## Web search (no API key)

The plugin also registers a `web_search` tool backed by Kiro's built-in web search,
the same one kiro-cli uses. It runs server-side on Kiro's backend through the
CodeWhisperer `InvokeMCP` operation, authenticated with the same OpenCode-owned
credential selected by the active model, so it needs no third-party search API key.

- `mcp.ts` calls `InvokeMCP` (JSON-RPC `tools/call` for `web_search`) and parses the
  `{ "results": [...] }` payload.
- `tools.ts` exposes it to opencode as the `web_search` tool, returning titles, URLs,
  and snippets with inline citation hints.

Verify it end to end through OpenCode (prints no token):
`bun run script/test-websearch.ts "latest Node.js LTS version"`

## Credits

Original author: Toan Doan <toandev.95@gmail.com>
([toandev95/opencode-kiro-auth](https://github.com/toandev95/opencode-kiro-auth)).

Fork maintainer: Hongyi Lyu.
