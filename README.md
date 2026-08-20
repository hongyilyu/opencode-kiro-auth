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

Use Kiro models as opencode providers with AWS SSO OIDC or API-key authentication.
Both providers can be configured together and selected per request:

| Provider | Credential | Use with |
| --- | --- | --- |
| `kiro` | AWS Builder ID or IAM Identity Center device flow | `--model kiro/claude-sonnet-4.6` |
| `kiro-api` | API key | `--model kiro-api/claude-sonnet-4.6` |

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

When working from a source checkout, optional diagnostics are available:
`bun run check-auth` verifies the configured credential end to end, and
`bun run list-models` prints OpenCode's resolved Kiro model catalog. Neither command
is needed when using the plugin from npm.

### Migrating from 1.x

Versions through `1.2.0` stored only a sentinel in OpenCode and read kiro-cli's
credential at request time. That sentinel cannot be migrated because it contains no
refresh credentials. Run `opencode auth login --provider kiro` once after upgrading.

### Credential storage

OpenCode manages each provider's credential independently. OAuth refreshes are written
back through OpenCode's auth API. Credentials are sensitive; do not share or commit
OpenCode's auth data.

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
- `transform.ts` maps the Anthropic Messages request opencode sends into Kiro's
  CodeWhisperer `GenerateAssistantResponse` request (text, tool calls, images), and
  converts the AWS event-stream response back into an Anthropic SSE stream. Before any
  output, throttling becomes HTTP 429, timeouts become HTTP 504, and a stream that ends
  without text or a tool call becomes HTTP 502, so opencode retries instead of recording
  a successful empty assistant turn. A terminal `CONTENT_FILTERED` event becomes a clear
  non-retryable HTTP 400, including Kiro's refusal category and recovery guidance, because
  retrying the same conversation cannot change the result.
- `plugin.ts` registers the provider auth hooks and intercepting fetches.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
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

## Web search

The plugin also registers a `web_search` tool backed by Kiro's built-in web search,
the same one kiro-cli uses. It runs server-side on Kiro's backend through the
CodeWhisperer `InvokeMCP` operation, authenticated with the same OpenCode-owned
credential selected by the active model.

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
