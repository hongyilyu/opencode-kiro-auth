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

Use Kiro models as an opencode provider with a direct AWS SSO OIDC login. The plugin
dynamically registers its own OAuth client, runs the device flow, and stores the resulting
credential in OpenCode's credential store. It never reads kiro-cli files, databases, or
keychains, and kiro-cli does not need to be installed.

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

When working from a source checkout, optional diagnostics are available:
`bun run check-auth` verifies the configured credential end to end, and
`bun run list-models` prints OpenCode's resolved Kiro model catalog. Neither command
is needed when using the plugin from npm.

### Migrating from 1.x

Versions through `1.2.0` stored only a sentinel in OpenCode and read kiro-cli's
credential at request time. That sentinel cannot be migrated because it contains no
refresh credentials. Run `opencode auth login --provider kiro` once after upgrading.

### Credential storage

The OAuth access token, refresh token, and dynamic client registration are stored as
the `kiro` provider credential by OpenCode. Refreshes are written back through
OpenCode's auth API. This credential is sensitive; do not share or commit OpenCode's
auth data.

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
- `profile.ts` resolves the profileArn like kiro-cli: real ARN for accounts that
  have one, else the fixed Builder-ID placeholder.
- `transform.ts` maps the Anthropic Messages request opencode sends into Kiro's
  CodeWhisperer `GenerateAssistantResponse` request (text, tool calls, images), and
  converts the AWS event-stream response back into an Anthropic SSE stream. Pre-output
  throttling exceptions are promoted to HTTP 429 responses so opencode keeps retrying.
- `plugin.ts` registers the opencode `auth` hook whose loader returns the
  intercepting `fetch`.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `KIRO_RATE_LIMIT_RETRY_SECONDS` | Unset | Positive integer that overrides the retry interval for HTTP 429 and pre-output throttling responses. When unset or invalid, upstream `Retry-After` values and opencode's normal backoff are preserved. |
| `KIRO_KEEP_IMAGE_TURNS` | `2` | Number of recent image-bearing turns retained in requests. Set to `0` to strip all images. |

Example: `KIRO_RATE_LIMIT_RETRY_SECONDS=10 opencode`.

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
CodeWhisperer `InvokeMCP` operation, authenticated with the same OpenCode-owned login,
so it needs no third-party search API key.

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
